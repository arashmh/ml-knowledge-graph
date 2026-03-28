# ML Knowledge Graph Explorer

Interactive 3D knowledge graph visualizer for 2,081 machine learning and mathematics concepts with 5,149 prerequisite edges. Explore the graph in three dimensions — rotate, zoom, pan — with multiple layout algorithms and upstream dependency highlighting.

## Local Development

No build step required. Serve the static files with any HTTP server:

```bash
# Python
python3 -m http.server 8000

# Node.js (npx, no install needed)
npx serve .
```

Then open http://localhost:8000 in your browser.

## Usage

- **Rotate**: drag
- **Zoom**: scroll
- **Pan**: right-drag
- **Click** a node to focus its prerequisite/dependent context
- **Shift+Click** additional nodes to build a multi-node selection group
- **Double-click** a node for ego-centric radial layout
- **Search** to filter concepts by name
- **Layout selector** to switch between Force, Hierarchical, Cluster, and Radial views
- **Legend** — click a cluster to highlight all its nodes
