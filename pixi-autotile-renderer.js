import { Application, Container, Graphics, Texture, extensions } from './lib/pixi_8.16_.min.js';
import { CompositeTilemap, TilemapPipe, settings as tilemapSettings } from './lib/pixi-tilemap-module.js';

let tilemapPipeRegistered = false;

function ensureTilemapSupport() {
    if (!tilemapPipeRegistered) {
        extensions.add(TilemapPipe);
        tilemapPipeRegistered = true;
    }

    tilemapSettings.use32bitIndex = true;
    tilemapSettings.TEXTILE_SCALE_MODE = 'nearest';
}

function destroyTilemap(tilemap) {
    if (!tilemap) return;
    tilemap.removeFromParent();
    tilemap.destroy({ children: true });
}

export async function createPixiAutotileRenderer({ canvas, backgroundColor = 0xf0e68c }) {
    ensureTilemapSupport();

    const app = new Application();
    await app.init({
        width: Math.max(canvas.width || 1, 1),
        height: Math.max(canvas.height || 1, 1),
        resolution: 1,
        canvas,
        backgroundColor,
        antialias: false,
        powerPreference: 'high-performance',
        preference: 'webgl',
    });

    app.stage.sortableChildren = true;
    if (app.ticker) {
        app.ticker.stop();
    }

    const viewport = new Container();
    const content = new Container();
    const layersContainer = new Container();
    const gridOverlay = new Graphics();

    layersContainer.sortableChildren = true;
    content.addChild(layersContainer);
    content.addChild(gridOverlay);
    viewport.addChild(content);
    app.stage.addChild(viewport);

    const textureCache = new WeakMap();
    const layerStates = new Map();

    let lastGridKey = '';

    function getTexture(sourceCanvas) {
        let texture = textureCache.get(sourceCanvas);
        if (!texture) {
            texture = Texture.from(sourceCanvas);
            textureCache.set(sourceCanvas, texture);
        }
        return texture;
    }

    function pruneMissingLayers(layers) {
        const activeIds = new Set(layers.map(layer => layer.id));
        for (const [layerId, state] of layerStates.entries()) {
            if (!activeIds.has(layerId)) {
                destroyTilemap(state.tilemap);
                layerStates.delete(layerId);
            }
        }
    }

    function rebuildGrid(gridWidth, gridHeight, tileSize, canvasScale) {
        const gridKey = `${gridWidth}:${gridHeight}:${tileSize}:${canvasScale}`;
        if (gridKey === lastGridKey) return;

        lastGridKey = gridKey;
        gridOverlay.clear();

        const scaledTileSize = tileSize * canvasScale;
        gridOverlay.visible = scaledTileSize >= 4;
        if (!gridOverlay.visible) return;

        const logicalWidth = gridWidth * tileSize;
        const logicalHeight = gridHeight * tileSize;
        const strokeWidth = Math.max(0.5 / Math.max(canvasScale, 0.001), 0.25);

        for (let x = 0; x <= gridWidth; x++) {
            const px = x * tileSize;
            gridOverlay.moveTo(px, 0);
            gridOverlay.lineTo(px, logicalHeight);
        }

        for (let y = 0; y <= gridHeight; y++) {
            const py = y * tileSize;
            gridOverlay.moveTo(0, py);
            gridOverlay.lineTo(logicalWidth, py);
        }

        gridOverlay.stroke({ width: strokeWidth, color: 0xffffff, alpha: 0.1 });
    }

    function rebuildLayer(state, layer, sortedLayerIndex, helpers) {
        destroyTilemap(state.tilemap);

        if (!layer.tileset) {
            state.tilemap = null;
            state.tileset = null;
            state.dirty = false;
            return;
        }

        const tilemap = new CompositeTilemap([getTexture(layer.tileset)]);
        const halfTile = helpers.tileSize / 2;
        const subtileSize = 24;
        const isBackground = sortedLayerIndex === 0;
        const corners = [
            { key: 'NW', dx: 0, dy: 0, seedOffset: 0 },
            { key: 'NE', dx: halfTile, dy: 0, seedOffset: 1000 },
            { key: 'SW', dx: 0, dy: halfTile, seedOffset: 2000 },
            { key: 'SE', dx: halfTile, dy: halfTile, seedOffset: 3000 },
        ];

        if (isBackground) {
            const interiorSubtiles = [
                { x: 1, y: 3 }, { x: 2, y: 3 },
                { x: 1, y: 4 }, { x: 2, y: 4 },
            ];

            for (let y = 0; y < helpers.gridHeight; y++) {
                for (let x = 0; x < helpers.gridWidth; x++) {
                    const baseX = x * helpers.tileSize;
                    const baseY = y * helpers.tileSize;

                    for (const corner of corners) {
                        const rand = helpers.seededRandom(x, y, corner.seedOffset);
                        const subtile = interiorSubtiles[Math.floor(rand * interiorSubtiles.length)];
                        tilemap.tile(0, baseX + corner.dx, baseY + corner.dy, {
                            u: subtile.x * subtileSize,
                            v: subtile.y * subtileSize,
                            tileWidth: halfTile,
                            tileHeight: halfTile,
                            alpha: layer.opacity,
                        });
                    }
                }
            }
        } else {
            for (let y = 0; y < helpers.gridHeight; y++) {
                for (let x = 0; x < helpers.gridWidth; x++) {
                    if (!helpers.isFilledInLayer(layer, x, y)) continue;

                    const baseX = x * helpers.tileSize;
                    const baseY = y * helpers.tileSize;

                    for (const corner of corners) {
                        const srcPos = helpers.getSubtileCoords(layer, x, y, corner.key);
                        tilemap.tile(0, baseX + corner.dx, baseY + corner.dy, {
                            u: srcPos.x * subtileSize,
                            v: srcPos.y * subtileSize,
                            tileWidth: halfTile,
                            tileHeight: halfTile,
                            alpha: layer.opacity,
                        });
                    }
                }
            }
        }

        tilemap.alpha = layer.opacity;
        tilemap.visible = layer.visible;
        tilemap.zIndex = layer.order;
        layersContainer.addChild(tilemap);

        state.tilemap = tilemap;
        state.tileset = layer.tileset;
        state.dirty = false;
    }

    return {
        resize({ width, height, canvasScale }) {
            app.renderer.resize(Math.max(width, 1), Math.max(height, 1));
            content.scale.set(canvasScale);
            lastGridKey = '';
        },

        setCamera(camera) {
            viewport.position.set(camera.x, camera.y);
            viewport.scale.set(camera.zoom);
        },

        markLayerDirty(layerId) {
            const state = layerStates.get(layerId);
            if (state) {
                state.dirty = true;
            } else {
                layerStates.set(layerId, { tilemap: null, tileset: null, dirty: true });
            }
        },

        markAllDirty() {
            for (const state of layerStates.values()) {
                state.dirty = true;
            }
            lastGridKey = '';
        },

        removeLayer(layerId) {
            const state = layerStates.get(layerId);
            if (!state) return;
            destroyTilemap(state.tilemap);
            layerStates.delete(layerId);
        },

        render({ layers, sortedLayers, gridWidth, gridHeight, tileSize, canvasScale, isFilledInLayer, getSubtileCoords, seededRandom }) {
            pruneMissingLayers(layers);
            content.scale.set(canvasScale);

            for (let i = 0; i < sortedLayers.length; i++) {
                const layer = sortedLayers[i];
                let state = layerStates.get(layer.id);
                if (!state) {
                    state = { tilemap: null, tileset: null, dirty: true };
                    layerStates.set(layer.id, state);
                }

                if (state.tileset !== layer.tileset) {
                    state.dirty = true;
                }

                if (state.dirty) {
                    rebuildLayer(state, layer, i, {
                        gridWidth,
                        gridHeight,
                        tileSize,
                        isFilledInLayer,
                        getSubtileCoords,
                        seededRandom,
                    });
                }

                if (state.tilemap) {
                    state.tilemap.alpha = layer.opacity;
                    state.tilemap.visible = layer.visible;
                    state.tilemap.zIndex = layer.order;
                }
            }

            rebuildGrid(gridWidth, gridHeight, tileSize, canvasScale);
            app.render();
        },
    };
}
