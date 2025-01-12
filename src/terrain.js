import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.112.1/build/three.module.js";

import * as noise from "./noise.js";
import * as quadtree from "./quadtree.js";
import * as spline from "./spline.js";
import { TerrainChunk } from "./terrain-chunk.js";
import * as utils from "./utils.js";

const _WHITE = new THREE.Color(0x808080);

const _DEEP_OCEAN = new THREE.Color(0x20020ff);
const _SHALLOW_OCEAN = new THREE.Color(0x8080ff);
const _BEACH = new THREE.Color(0xd9d592);
const _SNOW = new THREE.Color(0xffffff);
const _FOREST_TROPICAL = new THREE.Color(0x4f9f0f);
const _FOREST_TEMPERATE = new THREE.Color(0x2b960e);
const _FOREST_BOREAL = new THREE.Color(0x29c100);

const _GREEN = new THREE.Color(0x80ff80);
const _RED = new THREE.Color(0xff8080);
const _BLACK = new THREE.Color(0x000000);

const _MIN_CELL_SIZE = 500;
const _MIN_CELL_RESOLUTION = 128;
const _PLANET_RADIUS = 4000;

class HeightGenerator {
  constructor(generator, position, minRadius, maxRadius) {
    this._position = position.clone();
    this._radius = [minRadius, maxRadius];
    this._generator = generator;
  }

  Get(x, y, z) {
    return [this._generator.Get(x, y, z), 1];
  }
}

class FixedHeightGenerator {
  constructor() {}

  Get() {
    return [50, 1];
  }
}

// Cross-blended Hypsometric Tints
// http://www.shadedrelief.com/hypso/hypso.html
class HyposemetricTints {
  constructor(params) {
    const _colourLerp = (t, p0, p1) => {
      const c = p0.clone();

      return c.lerp(p1, t);
    };
    this._colourSpline = [
      new spline.LinearSpline(_colourLerp),
      new spline.LinearSpline(_colourLerp),
    ];

    // Arid
    this._colourSpline[0].AddPoint(0.0, new THREE.Color(0xb7a67d));
    this._colourSpline[0].AddPoint(0.5, new THREE.Color(0xf1e1bc));
    this._colourSpline[0].AddPoint(1.0, _SNOW);

    // Humid
    this._colourSpline[1].AddPoint(0.0, _FOREST_BOREAL);
    this._colourSpline[1].AddPoint(0.5, new THREE.Color(0xcee59c));
    this._colourSpline[1].AddPoint(1.0, _SNOW);

    this._oceanSpline = new spline.LinearSpline(_colourLerp);
    this._oceanSpline.AddPoint(0, _DEEP_OCEAN);
    this._oceanSpline.AddPoint(0.03, _SHALLOW_OCEAN);
    this._oceanSpline.AddPoint(0.05, _SHALLOW_OCEAN);

    this._params = params;
  }

  Get(x, y, z) {
    const m = this._params.biomeGenerator.Get(x, y, z);
    const h = z / 100.0;

    if (h < 0.05) {
      return this._oceanSpline.Get(h);
    }

    const c1 = this._colourSpline[0].Get(h);
    const c2 = this._colourSpline[1].Get(h);

    return c1.lerp(c2, m);
  }
}

class FixedColourGenerator {
  constructor(params) {
    this._params = params;
  }

  Get() {
    return this._params.colour;
  }
}

class TerrainChunkRebuilder {
  constructor(params) {
    this._pool = {};
    this._params = params;
    this._Reset();
  }

  AllocateChunk(params) {
    const w = params.width;

    if (!(w in this._pool)) {
      this._pool[w] = [];
    }

    let c = null;
    if (this._pool[w].length > 0) {
      c = this._pool[w].pop();
      c._params = params;
    } else {
      c = new TerrainChunk(params);
    }

    c.Hide();

    this._queued.push(c);

    return c;
  }

  _RecycleChunks(chunks) {
    for (let c of chunks) {
      if (!(c.chunk._params.width in this._pool)) {
        this._pool[c.chunk._params.width] = [];
      }

      c.chunk.Destroy();
    }
  }

  _Reset() {
    this._active = null;
    this._queued = [];
    this._old = [];
    this._new = [];
  }

  get Busy() {
    return this._active || this._queued.length > 0;
  }

  Rebuild(chunks) {
    if (this.Busy) {
      return;
    }
    for (let k in chunks) {
      this._queued.push(chunks[k].chunk);
    }
  }

  Update() {
    if (this._active) {
      const r = this._active.next();
      if (r.done) {
        this._active = null;
      }
    } else {
      const b = this._queued.pop();
      if (b) {
        this._active = b._Rebuild();
        this._new.push(b);
      }
    }

    if (this._active) {
      return;
    }

    if (!this._queued.length) {
      this._RecycleChunks(this._old);
      for (let b of this._new) {
        b.Show();
      }
      this._Reset();
    }
  }
}

export class TerrainChunkManager {
  constructor(params) {
    this._Init(params);
  }

  _Init(params) {
    this._params = params;

    this._material = new THREE.MeshStandardMaterial({
      wireframe: false,
      wireframeLinewidth: 1,
      color: 0xffffff,
      side: THREE.FrontSide,
      vertexColors: THREE.VertexColors,
    });
    this._builder = new TerrainChunkRebuilder();

    this._InitNoise(params);
    this._InitBiomes(params);
    this._InitTerrain(params);
  }

  _InitNoise(params) {
    params.guiParams.noise = {
      octaves: 13,
      persistence: 0.707,
      lacunarity: 1.8,
      exponentiation: 4.5,
      height: 300.0,
      scale: 1100.0,
      seed: 1,
    };

    const onNoiseChanged = () => {
      this._builder.Rebuild(this._chunks);
    };

    const noiseRollup = params.gui.addFolder("Terrain.Noise");
    noiseRollup
      .add(params.guiParams.noise, "scale", 32.0, 4096.0)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.noise, "octaves", 1, 20, 1)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.noise, "persistence", 0.25, 1.0)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.noise, "lacunarity", 0.01, 4.0)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.noise, "exponentiation", 0.1, 10.0)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.noise, "height", 0, 512)
      .onChange(onNoiseChanged);

    this._noise = new noise.Noise(params.guiParams.noise);

    params.guiParams.heightmap = {
      height: 16,
    };

    const heightmapRollup = params.gui.addFolder("Terrain.Heightmap");
    heightmapRollup
      .add(params.guiParams.heightmap, "height", 0, 128)
      .onChange(onNoiseChanged);
  }

  _InitBiomes(params) {
    params.guiParams.biomes = {
      octaves: 2,
      persistence: 0.5,
      lacunarity: 2.0,
      exponentiation: 3.9,
      scale: 2048.0,
      noiseType: "simplex",
      seed: 2,
      exponentiation: 1,
      height: 1,
    };

    const onNoiseChanged = () => {
      this._builder.Rebuild(this._chunks);
    };

    const noiseRollup = params.gui.addFolder("Terrain.Biomes");
    noiseRollup
      .add(params.guiParams.biomes, "scale", 64.0, 4096.0)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.biomes, "octaves", 1, 20, 1)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.biomes, "persistence", 0.01, 1.0)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.biomes, "lacunarity", 0.01, 4.0)
      .onChange(onNoiseChanged);
    noiseRollup
      .add(params.guiParams.biomes, "exponentiation", 0.1, 10.0)
      .onChange(onNoiseChanged);

    this._biomes = new noise.Noise(params.guiParams.biomes);
  }

  _InitTerrain(params) {
    params.guiParams.terrain = {
      wireframe: false,
    };

    this._groups = [...new Array(6)].map((_) => new THREE.Group());
    params.scene.add(...this._groups);

    const terrainRollup = params.gui.addFolder("Terrain");
    terrainRollup.add(params.guiParams.terrain, "wireframe").onChange(() => {
      for (let k in this._chunks) {
        this._chunks[k].chunk._plane.material.wireframe =
          params.guiParams.terrain.wireframe;
      }
    });

    this._chunks = {};
    this._params = params;
  }

  _CellIndex(p) {
    const xp = p.x + _MIN_CELL_SIZE * 0.5;
    const yp = p.z + _MIN_CELL_SIZE * 0.5;
    const x = Math.floor(xp / _MIN_CELL_SIZE);
    const z = Math.floor(yp / _MIN_CELL_SIZE);
    return [x, z];
  }

  _CreateTerrainChunk(group, offset, width, resolution) {
    const params = {
      group: group,
      material: this._material,
      width: width,
      offset: offset,
      radius: _PLANET_RADIUS,
      resolution: resolution,
      biomeGenerator: this._biomes,
      colourGenerator: new HyposemetricTints({ biomeGenerator: this._biomes }),
      heightGenerators: [
        // new FixedHeightGenerator()
        new HeightGenerator(this._noise, offset, 100000, 100000 + 1),
      ],
    };

    return this._builder.AllocateChunk(params);
  }

  Update(_) {
    this._builder.Update();
    if (!this._builder.Busy) {
      this._UpdateVisibleChunks_Quadtree();
    }
  }

  _UpdateVisibleChunks_Quadtree() {
    function _Key(c) {
      return (
        c.position[0] +
        "/" +
        c.position[1] +
        " [" +
        c.size +
        "]" +
        " [" +
        c.index +
        "]"
      );
    }

    const q = new quadtree.CubeQuadTree({
      radius: _PLANET_RADIUS,
      min_node_size: _MIN_CELL_SIZE,
    });
    q.Insert(this._params.camera.position);

    const sides = q.GetChildren();

    let newTerrainChunks = {};
    const center = new THREE.Vector3();
    const dimensions = new THREE.Vector3();
    for (let i = 0; i < sides.length; i++) {
      this._groups[i].matrix = sides[i].transform;
      this._groups[i].matrixAutoUpdate = false;
      for (let c of sides[i].children) {
        c.bounds.getCenter(center);
        c.bounds.getSize(dimensions);

        const child = {
          index: i,
          group: this._groups[i],
          position: [center.x, center.y, center.z],
          bounds: c.bounds,
          size: dimensions.x,
        };

        const k = _Key(child);
        newTerrainChunks[k] = child;
      }
    }

    const intersection = utils.DictIntersection(this._chunks, newTerrainChunks);
    const difference = utils.DictDifference(newTerrainChunks, this._chunks);
    const recycle = Object.values(
      utils.DictDifference(this._chunks, newTerrainChunks)
    );

    this._builder._old.push(...recycle);

    newTerrainChunks = intersection;

    for (let k in difference) {
      const [xp, yp, zp] = difference[k].position;

      const offset = new THREE.Vector3(xp, yp, zp);
      newTerrainChunks[k] = {
        position: [xp, zp],
        chunk: this._CreateTerrainChunk(
          difference[k].group,
          offset,
          difference[k].size,
          _MIN_CELL_RESOLUTION
        ),
      };
    }

    this._chunks = newTerrainChunks;
  }
}
