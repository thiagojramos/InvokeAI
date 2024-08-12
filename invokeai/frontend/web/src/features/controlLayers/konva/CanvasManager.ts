import type { Store } from '@reduxjs/toolkit';
import { logger } from 'app/logging/logger';
import type { RootState } from 'app/store/store';
import type { JSONObject } from 'common/types';
import type { CanvasBrushLineRenderer } from 'features/controlLayers/konva/CanvasBrushLine';
import type { CanvasEraserLineRenderer } from 'features/controlLayers/konva/CanvasEraserLine';
import type { CanvasImageRenderer } from 'features/controlLayers/konva/CanvasImage';
import { CanvasObjectRenderer } from 'features/controlLayers/konva/CanvasObjectRenderer';
import type { CanvasRectRenderer } from 'features/controlLayers/konva/CanvasRect';
import type { CanvasTransformer } from 'features/controlLayers/konva/CanvasTransformer';
import { MAX_CANVAS_SCALE, MIN_CANVAS_SCALE } from 'features/controlLayers/konva/constants';
import {
  getImageDataTransparency,
  getPrefixedId,
  konvaNodeToBlob,
  konvaNodeToImageData,
  nanoid,
} from 'features/controlLayers/konva/util';
import type { Extents, ExtentsResult, GetBboxTask, WorkerLogMessage } from 'features/controlLayers/konva/worker';
import type {
  CanvasV2State,
  Coordinate,
  Dimensions,
  GenerationMode,
  GetLoggingContext,
  Rect,
} from 'features/controlLayers/store/types';
import { isValidLayer } from 'features/nodes/util/graph/generation/addLayers';
import type Konva from 'konva';
import { clamp } from 'lodash-es';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';
import { getImageDTO, uploadImage } from 'services/api/endpoints/images';
import type { ImageDTO } from 'services/api/types';
import { assert } from 'tsafe';

import { CanvasBackground } from './CanvasBackground';
import { CanvasControlAdapter } from './CanvasControlAdapter';
import { CanvasLayerAdapter } from './CanvasLayerAdapter';
import { CanvasMaskAdapter } from './CanvasMaskAdapter';
import { CanvasPreview } from './CanvasPreview';
import { CanvasStagingArea } from './CanvasStagingArea';
import { CanvasStateApi } from './CanvasStateApi';
import { setStageEventHandlers } from './events';

export const $canvasManager = atom<CanvasManager | null>(null);

export class CanvasManager {
  stage: Konva.Stage;
  container: HTMLDivElement;
  controlAdapters: Map<string, CanvasControlAdapter>;
  layers: Map<string, CanvasLayerAdapter>;
  regions: Map<string, CanvasMaskAdapter>;
  inpaintMask: CanvasMaskAdapter;
  stateApi: CanvasStateApi;
  preview: CanvasPreview;
  background: CanvasBackground;

  log: Logger;
  workerLog: Logger;

  _store: Store<RootState>;
  _prevState: CanvasV2State;
  _isFirstRender: boolean = true;
  _isDebugging: boolean = false;

  _worker: Worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'worker' });
  _tasks: Map<string, { task: GetBboxTask; onComplete: (extents: Extents | null) => void }> = new Map();

  constructor(stage: Konva.Stage, container: HTMLDivElement, store: Store<RootState>) {
    this.stage = stage;
    this.container = container;
    this._store = store;
    this.stateApi = new CanvasStateApi(this._store, this);

    this._prevState = this.stateApi.getState();

    this.log = logger('canvas').child((message) => {
      return {
        ...message,
        context: {
          ...message.context,
          ...this.getLoggingContext(),
        },
      };
    });
    this.workerLog = logger('worker');

    this.preview = new CanvasPreview(this);
    this.stage.add(this.preview.getLayer());

    this.background = new CanvasBackground(this);
    this.stage.add(this.background.konva.layer);

    this.layers = new Map();
    this.regions = new Map();
    this.controlAdapters = new Map();

    this._worker.onmessage = (event: MessageEvent<ExtentsResult | WorkerLogMessage>) => {
      const { type, data } = event.data;
      if (type === 'log') {
        if (data.ctx) {
          this.workerLog[data.level](data.ctx, data.message);
        } else {
          this.workerLog[data.level](data.message);
        }
      } else if (type === 'extents') {
        const task = this._tasks.get(data.id);
        if (!task) {
          return;
        }
        task.onComplete(data.extents);
        this._tasks.delete(data.id);
      }
    };
    this._worker.onerror = (event) => {
      this.log.error({ message: event.message }, 'Worker error');
    };
    this._worker.onmessageerror = () => {
      this.log.error('Worker message error');
    };

    this.stateApi.$transformingEntity.set(null);
    this.stateApi.$toolState.set(this.stateApi.getToolState());
    this.stateApi.$selectedEntityIdentifier.set(this.stateApi.getState().selectedEntityIdentifier);
    this.stateApi.$currentFill.set(this.stateApi.getCurrentFill());
    this.stateApi.$selectedEntity.set(this.stateApi.getSelectedEntity());

    this.inpaintMask = new CanvasMaskAdapter(this.stateApi.getInpaintMaskState(), this);
    this.stage.add(this.inpaintMask.konva.layer);
  }

  enableDebugging() {
    this._isDebugging = true;
    this.logDebugInfo();
  }

  disableDebugging() {
    this._isDebugging = false;
  }

  requestBbox(data: Omit<GetBboxTask['data'], 'id'>, onComplete: (extents: Extents | null) => void) {
    const id = nanoid();
    const task: GetBboxTask = {
      type: 'get_bbox',
      data: { ...data, id },
    };
    this._tasks.set(id, { task, onComplete });
    this._worker.postMessage(task, [data.buffer]);
  }

  async renderControlAdapters() {
    const { entities } = this.stateApi.getControlAdaptersState();

    for (const canvasControlAdapter of this.controlAdapters.values()) {
      if (!entities.find((ca) => ca.id === canvasControlAdapter.id)) {
        canvasControlAdapter.destroy();
        this.controlAdapters.delete(canvasControlAdapter.id);
      }
    }

    for (const entity of entities) {
      let adapter = this.controlAdapters.get(entity.id);
      if (!adapter) {
        adapter = new CanvasControlAdapter(entity, this);
        this.controlAdapters.set(adapter.id, adapter);
        this.stage.add(adapter.konva.layer);
      }
      await adapter.render(entity);
    }
  }

  arrangeEntities() {
    const { getLayersState, getControlAdaptersState, getRegionsState } = this.stateApi;
    const layers = getLayersState().entities;
    const controlAdapters = getControlAdaptersState().entities;
    const regions = getRegionsState().entities;
    let zIndex = 0;
    this.background.konva.layer.zIndex(++zIndex);
    for (const layer of layers) {
      this.layers.get(layer.id)?.konva.layer.zIndex(++zIndex);
    }
    for (const ca of controlAdapters) {
      this.controlAdapters.get(ca.id)?.konva.layer.zIndex(++zIndex);
    }
    for (const rg of regions) {
      this.regions.get(rg.id)?.konva.layer.zIndex(++zIndex);
    }
    this.inpaintMask.konva.layer.zIndex(++zIndex);
    this.preview.getLayer().zIndex(++zIndex);
  }

  fitStageToContainer() {
    this.stage.width(this.container.offsetWidth);
    this.stage.height(this.container.offsetHeight);
    this.stateApi.$stageAttrs.set({
      x: this.stage.x(),
      y: this.stage.y(),
      width: this.stage.width(),
      height: this.stage.height(),
      scale: this.stage.scaleX(),
    });
  }

  resetView() {
    const { width, height } = this.getStageSize();
    const { rect } = this.stateApi.getBbox();

    const padding = 20; // Padding in absolute pixels

    const availableWidth = width - padding * 2;
    const availableHeight = height - padding * 2;

    const scale = Math.min(Math.min(availableWidth / rect.width, availableHeight / rect.height), 1);
    const x = -rect.x * scale + padding + (availableWidth - rect.width * scale) / 2;
    const y = -rect.y * scale + padding + (availableHeight - rect.height * scale) / 2;

    this.stage.setAttrs({
      x,
      y,
      scaleX: scale,
      scaleY: scale,
    });

    this.stateApi.$stageAttrs.set({
      ...this.stateApi.$stageAttrs.get(),
      x,
      y,
      scale,
    });
  }

  getTransformingLayer() {
    const transformingEntity = this.stateApi.$transformingEntity.get();
    if (!transformingEntity) {
      return null;
    }

    const { id, type } = transformingEntity;

    if (type === 'layer') {
      return this.layers.get(id) ?? null;
    } else if (type === 'inpaint_mask') {
      return this.inpaintMask;
    } else if (type === 'regional_guidance') {
      return this.regions.get(id) ?? null;
    }

    return null;
  }

  getIsTransforming() {
    return Boolean(this.stateApi.$transformingEntity.get());
  }

  startTransform() {
    if (this.getIsTransforming()) {
      return;
    }
    const entity = this.stateApi.getSelectedEntity();
    if (!entity) {
      this.log.warn('No entity selected to transform');
      return;
    }
    // TODO(psyche): Support other entity types
    entity.adapter.transformer.startTransform();
    this.stateApi.$transformingEntity.set({ id: entity.id, type: entity.type });
  }

  async applyTransform() {
    const layer = this.getTransformingLayer();
    if (layer) {
      await layer.transformer.applyTransform();
    }
    this.stateApi.$transformingEntity.set(null);
  }

  cancelTransform() {
    const layer = this.getTransformingLayer();
    if (layer) {
      layer.transformer.stopTransform();
    }
    this.stateApi.$transformingEntity.set(null);
  }

  render = async () => {
    const state = this.stateApi.getState();

    if (this._prevState === state && !this._isFirstRender) {
      this.log.trace('No changes detected, skipping render');
      return;
    }

    if (this._isFirstRender || state.layers.entities !== this._prevState.layers.entities) {
      this.log.debug('Rendering layers');

      for (const canvasLayer of this.layers.values()) {
        if (!state.layers.entities.find((l) => l.id === canvasLayer.id)) {
          await canvasLayer.destroy();
          this.layers.delete(canvasLayer.id);
        }
      }

      for (const entityState of state.layers.entities) {
        let adapter = this.layers.get(entityState.id);
        if (!adapter) {
          adapter = new CanvasLayerAdapter(entityState, this);
          this.layers.set(adapter.id, adapter);
          this.stage.add(adapter.konva.layer);
        }
        await adapter.update({
          state: entityState,
          toolState: state.tool,
          isSelected: state.selectedEntityIdentifier?.id === entityState.id,
        });
      }
    }

    if (
      this._isFirstRender ||
      state.regions.entities !== this._prevState.regions.entities ||
      state.settings.maskOpacity !== this._prevState.settings.maskOpacity ||
      state.tool.selected !== this._prevState.tool.selected ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Rendering regions');

      // Destroy the konva nodes for nonexistent entities
      for (const canvasRegion of this.regions.values()) {
        if (!state.regions.entities.find((rg) => rg.id === canvasRegion.id)) {
          canvasRegion.destroy();
          this.regions.delete(canvasRegion.id);
        }
      }

      for (const entityState of state.regions.entities) {
        let adapter = this.regions.get(entityState.id);
        if (!adapter) {
          adapter = new CanvasMaskAdapter(entityState, this);
          this.regions.set(adapter.id, adapter);
          this.stage.add(adapter.konva.layer);
        }
        await adapter.update({
          state: entityState,
          toolState: state.tool,
          isSelected: state.selectedEntityIdentifier?.id === entityState.id,
        });
      }
    }

    if (
      this._isFirstRender ||
      state.inpaintMask !== this._prevState.inpaintMask ||
      state.settings.maskOpacity !== this._prevState.settings.maskOpacity ||
      state.tool.selected !== this._prevState.tool.selected ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Rendering inpaint mask');
      await this.inpaintMask.update({
        state: state.inpaintMask,
        toolState: state.tool,
        isSelected: state.selectedEntityIdentifier?.id === state.inpaintMask.id,
      });
    }

    if (
      this._isFirstRender ||
      state.controlAdapters.entities !== this._prevState.controlAdapters.entities ||
      state.tool.selected !== this._prevState.tool.selected ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Rendering control adapters');
      await this.renderControlAdapters();
    }

    this.stateApi.$toolState.set(state.tool);
    this.stateApi.$selectedEntityIdentifier.set(state.selectedEntityIdentifier);
    this.stateApi.$selectedEntity.set(this.stateApi.getSelectedEntity());
    this.stateApi.$currentFill.set(this.stateApi.getCurrentFill());

    if (
      this._isFirstRender ||
      state.bbox !== this._prevState.bbox ||
      state.tool.selected !== this._prevState.tool.selected
    ) {
      this.log.debug('Rendering generation bbox');
      await this.preview.bbox.render();
    }

    if (
      this._isFirstRender ||
      state.layers !== this._prevState.layers ||
      state.controlAdapters !== this._prevState.controlAdapters ||
      state.regions !== this._prevState.regions
    ) {
      // this.log.debug('Updating entity bboxes');
      // debouncedUpdateBboxes(stage, canvasV2.layers, canvasV2.controlAdapters, canvasV2.regions, onBboxChanged);
    }

    if (this._isFirstRender || state.session !== this._prevState.session) {
      this.log.debug('Rendering staging area');
      await this.preview.stagingArea.render();
    }

    if (
      this._isFirstRender ||
      state.layers.entities !== this._prevState.layers.entities ||
      state.controlAdapters.entities !== this._prevState.controlAdapters.entities ||
      state.regions.entities !== this._prevState.regions.entities ||
      state.inpaintMask !== this._prevState.inpaintMask ||
      state.selectedEntityIdentifier?.id !== this._prevState.selectedEntityIdentifier?.id
    ) {
      this.log.debug('Arranging entities');
      await this.arrangeEntities();
    }

    this._prevState = state;

    if (this._isFirstRender) {
      this._isFirstRender = false;
    }
  };

  initialize = () => {
    this.log.debug('Initializing renderer');
    this.stage.container(this.container);

    const unsubscribeListeners = setStageEventHandlers(this);

    // We can use a resize observer to ensure the stage always fits the container. We also need to re-render the bg and
    // document bounds overlay when the stage is resized.
    const resizeObserver = new ResizeObserver(this.fitStageToContainer.bind(this));
    resizeObserver.observe(this.container);
    this.fitStageToContainer();

    const unsubscribeRenderer = this._store.subscribe(this.render);

    this.log.debug('First render of konva stage');
    this.preview.tool.render();
    this.render();

    return () => {
      this.log.debug('Cleaning up konva renderer');
      this.inpaintMask.destroy();
      for (const region of this.regions.values()) {
        region.destroy();
      }
      for (const layer of this.layers.values()) {
        layer.destroy();
      }
      for (const controlAdapter of this.controlAdapters.values()) {
        controlAdapter.destroy();
      }
      this.background.destroy();
      this.preview.destroy();
      unsubscribeRenderer();
      unsubscribeListeners();
      resizeObserver.disconnect();
    };
  };

  /**
   * Gets the center of the stage in either absolute or relative coordinates
   * @param absolute Whether to return the center in absolute coordinates
   */
  getStageCenter(absolute = false): Coordinate {
    const scale = this.getStageScale();
    const { x, y } = this.getStagePosition();
    const { width, height } = this.getStageSize();

    const center = {
      x: (width / 2 - x) / scale,
      y: (height / 2 - y) / scale,
    };

    if (!absolute) {
      return center;
    }

    return this.stage.getAbsoluteTransform().point(center);
  }

  /**
   * Sets the scale of the stage. If center is provided, the stage will zoom in/out on that point.
   * @param scale The new scale to set
   * @param center The center of the stage to zoom in/out on
   */
  setStageScale(scale: number, center: Coordinate = this.getStageCenter(true)) {
    const newScale = clamp(Math.round(scale * 100) / 100, MIN_CANVAS_SCALE, MAX_CANVAS_SCALE);

    const { x, y } = this.getStagePosition();
    const oldScale = this.getStageScale();

    const deltaX = (center.x - x) / oldScale;
    const deltaY = (center.y - y) / oldScale;

    const newX = center.x - deltaX * newScale;
    const newY = center.y - deltaY * newScale;

    this.stage.setAttrs({
      x: newX,
      y: newY,
      scaleX: newScale,
      scaleY: newScale,
    });

    this.stateApi.$stageAttrs.set({
      x: Math.floor(this.stage.x()),
      y: Math.floor(this.stage.y()),
      width: this.stage.width(),
      height: this.stage.height(),
      scale: this.stage.scaleX(),
    });
  }

  /**
   * Gets the scale of the stage. The stage is always scaled uniformly in x and y.
   */
  getStageScale(): number {
    // The stage is never scaled differently in x and y
    return this.stage.scaleX();
  }

  /**
   * Gets the position of the stage.
   */
  getStagePosition(): Coordinate {
    return this.stage.position();
  }

  /**
   * Gets the size of the stage.
   */
  getStageSize(): Dimensions {
    return this.stage.size();
  }

  /**
   * Scales a number of pixels by the current stage scale. For example, if the stage is scaled by 5, then 10 pixels
   * would be scaled to 10px / 5 = 2 pixels.
   * @param pixels The number of pixels to scale
   * @returns The number of pixels scaled by the current stage scale
   */
  getScaledPixels(pixels: number): number {
    return pixels / this.getStageScale();
  }

  getCompositeLayerStageClone = (): Konva.Stage => {
    const layersState = this.stateApi.getLayersState();
    const stageClone = this.stage.clone();

    stageClone.scaleX(1);
    stageClone.scaleY(1);
    stageClone.x(0);
    stageClone.y(0);

    const validLayers = layersState.entities.filter(isValidLayer);
    // getLayers() returns the internal `children` array of the stage directly - calling destroy on a layer will
    // mutate that array. We need to clone the array to avoid mutating the original.
    for (const konvaLayer of stageClone.getLayers().slice()) {
      if (!validLayers.find((l) => l.id === konvaLayer.id())) {
        konvaLayer.destroy();
      }
    }

    return stageClone;
  };

  getCompositeLayerBlob = (rect?: Rect): Promise<Blob> => {
    return konvaNodeToBlob(this.getCompositeLayerStageClone(), rect);
  };

  getCompositeLayerImageData = (rect?: Rect): ImageData => {
    return konvaNodeToImageData(this.getCompositeLayerStageClone(), rect);
  };

  getCompositeLayerImageDTO = async (rect?: Rect): Promise<ImageDTO> => {
    const blob = await this.getCompositeLayerBlob(rect);
    const imageDTO = await uploadImage(blob, 'composite-layer.png', 'general', true);
    this.stateApi.setLayerImageCache(imageDTO);
    return imageDTO;
  };

  getInpaintMaskBlob = (rect?: Rect): Promise<Blob> => {
    return this.inpaintMask.renderer.getBlob({ rect });
  };

  getInpaintMaskImageData = (rect?: Rect): ImageData => {
    return this.inpaintMask.renderer.getImageData({ rect });
  };

  getInpaintMaskImageDTO = async (rect?: Rect): Promise<ImageDTO> => {
    const blob = await this.inpaintMask.renderer.getBlob({ rect });
    const imageDTO = await uploadImage(blob, 'inpaint-mask.png', 'mask', true);
    this.stateApi.setInpaintMaskImageCache(imageDTO);
    return imageDTO;
  };

  getRegionMaskImageDTO = async (id: string, rect?: Rect): Promise<ImageDTO> => {
    const region = this.stateApi.getEntity({ id, type: 'regional_guidance' });
    assert(region?.type === 'regional_guidance');
    if (region.state.imageCache) {
      const imageDTO = await getImageDTO(region.state.imageCache);
      if (imageDTO) {
        return imageDTO;
      }
    }
    return region.adapter.renderer.getImageDTO({
      rect,
      category: 'other',
      is_intermediate: true,
      onUploaded: (imageDTO) => {
        this.stateApi.setRegionMaskImageCache(region.state.id, imageDTO);
      },
    });
  };

  getGenerationMode(): GenerationMode {
    const { rect } = this.stateApi.getBbox();
    const inpaintMaskImageData = this.getInpaintMaskImageData(rect);
    const inpaintMaskTransparency = getImageDataTransparency(inpaintMaskImageData);
    const compositeLayerImageData = this.getCompositeLayerImageData(rect);
    const compositeLayerTransparency = getImageDataTransparency(compositeLayerImageData);
    if (compositeLayerTransparency === 'FULLY_TRANSPARENT') {
      // When the initial image is fully transparent, we are always doing txt2img
      return 'txt2img';
    } else if (compositeLayerTransparency === 'PARTIALLY_TRANSPARENT') {
      // When the initial image is partially transparent, we are always outpainting
      return 'outpaint';
    } else if (inpaintMaskTransparency === 'FULLY_TRANSPARENT') {
      // compositeLayerTransparency === 'OPAQUE'
      // When the inpaint mask is fully transparent, we are doing img2img
      return 'img2img';
    } else {
      // Else at least some of the inpaint mask is opaque, so we are inpainting
      return 'inpaint';
    }
  }

  getLoggingContext() {
    return {
      // timestamp: new Date().toISOString(),
    };
  }

  buildLogger(getContext: () => JSONObject): Logger {
    return this.log.child((message) => {
      return {
        ...message,
        context: {
          ...message.context,
          ...getContext(),
        },
      };
    });
  }

  buildGetLoggingContext = (
    instance:
      | CanvasBrushLineRenderer
      | CanvasEraserLineRenderer
      | CanvasRectRenderer
      | CanvasImageRenderer
      | CanvasTransformer
      | CanvasObjectRenderer
      | CanvasLayerAdapter
      | CanvasMaskAdapter
      | CanvasStagingArea
  ): GetLoggingContext => {
    if (
      instance instanceof CanvasLayerAdapter ||
      instance instanceof CanvasStagingArea ||
      instance instanceof CanvasMaskAdapter
    ) {
      return (extra?: JSONObject): JSONObject => {
        return {
          ...instance.manager.getLoggingContext(),
          entityId: instance.id,
          ...extra,
        };
      };
    } else if (instance instanceof CanvasObjectRenderer) {
      return (extra?: JSONObject): JSONObject => {
        return {
          ...instance.parent.getLoggingContext(),
          rendererId: instance.id,
          ...extra,
        };
      };
    } else {
      return (extra?: JSONObject): JSONObject => {
        return {
          ...instance.parent.getLoggingContext(),
          objectId: instance.id,
          ...extra,
        };
      };
    }
  };

  logDebugInfo() {
    // eslint-disable-next-line no-console
    console.log(this);
    for (const layer of this.layers.values()) {
      // eslint-disable-next-line no-console
      console.log(layer);
    }
  }

  getPrefixedId = getPrefixedId;
}