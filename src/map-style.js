// Custom MapLibre style for University of Sussex campus map
// Colors match the campus map PDF palette
// Vector tiles from OpenFreeMap (OpenMapTiles schema)

const style = {
  "version": 8,
  "name": "Sussex Campus",
  "sources": {
    "openmaptiles": {
      "type": "vector",
      "url": "https://tiles.openfreemap.org/planet"
    }
  },
  "glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  "layers": [
    {
      "id": "background",
      "type": "background",
      "paint": {
        "background-color": "#fdf8ce"
      }
    },
    {
      "id": "water",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "water",
      "paint": {
        "fill-color": "#a8d5e2",
        "fill-opacity": 1
      }
    },
    {
      "id": "waterway",
      "type": "line",
      "source": "openmaptiles",
      "source-layer": "waterway",
      "paint": {
        "line-color": "#a8d5e2",
        "line-width": 2
      }
    },
    {
      "id": "landcover-grass",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "landcover",
      "filter": [
        "==",
        "class",
        "grass"
      ],
      "paint": {
        "fill-color": "#7bb369",
        "fill-opacity": 0.7
      }
    },
    {
      "id": "landcover-wood",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "landcover",
      "filter": [
        "in",
        "class",
        "wood",
        "forest"
      ],
      "paint": {
        "fill-color": "#4a8c3f",
        "fill-opacity": 0.7
      }
    },
    {
      "id": "landuse-forest",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "landuse",
      "filter": [
        "in",
        "class",
        "wood",
        "forest"
      ],
      "paint": {
        "fill-color": "#4a8c3f",
        "fill-opacity": 0.7
      }
    },
    {
      "id": "landuse-green",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "landuse",
      "filter": [
        "in",
        "class",
        "park",
        "cemetery",
        "grass",
        "meadow",
        "village_green",
        "recreation_ground"
      ],
      "paint": {
        "fill-color": "#c8d8a0",
        "fill-opacity": 0.5
      }
    },
    {
      "id": "park",
      "type": "fill",
      "source": "openmaptiles",
      "source-layer": "park",
      "paint": {
        "fill-color": "#c8d8a0",
        "fill-opacity": 0.45
      }
    },
    {
      "id": "road-casing",
      "type": "line",
      "source": "openmaptiles",
      "source-layer": "transportation",
      "filter": [
        "all",
        ["!=", "class", "path"],
        ["!=", "class", "pedestrian"],
        ["!=", "class", "track"]
      ],
      "layout": { "line-cap": "round", "line-join": "round" },
      "paint": {
        "line-color": "#d6d6d6",
        "line-opacity": 1,
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3, 18, 14]
      }
    },
    {
      "id": "road",
      "type": "line",
      "source": "openmaptiles",
      "source-layer": "transportation",
      "filter": [
        "all",
        ["!=", "class", "path"],
        ["!=", "class", "pedestrian"],
        ["!=", "class", "track"]
      ],
      "layout": { "line-cap": "round", "line-join": "round" },
      "paint": {
        "line-color": "#ffffff",
        "line-opacity": 1,
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 10]
      }
    },
    {
      "id": "path",
      "type": "line",
      "source": "openmaptiles",
      "source-layer": "transportation",
      "filter": ["in", "class", "path", "pedestrian", "track"],
      "layout": { "line-cap": "round", "line-join": "round" },
      "paint": {
        "line-color": "#efb62b",
        "line-opacity": 0.45,
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1, 18, 4],
        "line-dasharray": [2, 1]
      }
    },
    {
      "id": "building",
      "type": "fill-extrusion",
      "source": "openmaptiles",
      "source-layer": "building",
      "paint": {
        "fill-extrusion-color": "#4b5cb3",
        "fill-extrusion-height": 12,
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.9
      }
    },
    {
      "id": "road-label",
      "type": "symbol",
      "source": "openmaptiles",
      "source-layer": "transportation_name",
      "layout": {
        "symbol-placement": "line",
        "text-field": "{name}",
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-max-angle": 30
      },
      "paint": {
        "text-color": "#013136",
        "text-halo-color": "#ffffff",
        "text-halo-width": 2
      }
    },
    {
      "id": "place-label",
      "type": "symbol",
      "source": "openmaptiles",
      "source-layer": "place",
      "layout": {
        "text-field": "{name}",
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 16, 16]
      },
      "paint": {
        "text-color": "#4a4a4a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 2
      }
    },
    {
      "id": "poi-label",
      "type": "symbol",
      "source": "openmaptiles",
      "source-layer": "poi",
      "minzoom": 16,
      "layout": {
        "visibility": "none",
        "text-field": "{name}",
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-offset": [0, 0.8],
        "text-anchor": "top"
      },
      "paint": {
        "text-color": "#4a4a4a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1
      }
    }
  ]
};

export default style;
