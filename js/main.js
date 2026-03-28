// App initialization and orchestration

import {
  loadGraph, getUpstream, getDownstream,
  getCategoryColor, getCategoryColorHex, getSortedCategories
} from './graph.js';
import * as Renderer from './renderer.js';
import {
  computeForceLayout, computeHierarchicalLayout,
  computeClusterLayout, computeRadialLayout, animateToPositions
} from './layouts.js';
import { setupInteraction } from './interaction.js';
import * as UI from './ui.js';

// --- App state ---
let graph = null;
let currentLayout = 'force';
let selectedNodeId = null;
let selectedNodeIds = new Set();
let hoveredNodeId = null;
let isAnimating = false;
let container = null;

const tooltip = document.getElementById('tooltip');
const tooltipLabel = document.getElementById('tooltip-label');
const tooltipShape = document.getElementById('tooltip-shape');
const tooltipBackdropPath = document.getElementById('tooltip-backdrop-path');
const tooltipConnectorPath = document.getElementById('tooltip-connector-path');
const BASE_EDGE_OPACITY = 0.32;
const SELECTED_CONTEXT_EDGE_OPACITY = 0.06;
const SEARCH_EDGE_OPACITY = 0.09;
const NON_FOCUS_NODE_OPACITY = 0.16;
const SEARCH_NON_MATCH_OPACITY = 0.18;
const PREREQUISITES_EDGE_COLOR = '#e8c547';
const DEPENDENTS_EDGE_COLOR = '#6290c3';
const SEARCH_EDGE_COLOR = '#f2f3f5';
const NODE_COLOR_MODE_CATEGORY = 'category';
const NODE_SIZE_MODE_DEFAULT = 'default';
const NODE_METRIC_KEYS = [
  '_pagerank',
  '_degree_centrality',
  '_betweenness_centrality',
  '_descendant_ratio',
  '_prerequisite_ratio',
  '_reachability_ratio',
];
const METRIC_COLOR_HUE_START = 218 / 360;
const METRIC_COLOR_HUE_END = 22 / 360;
const METRIC_COLOR_SATURATION_START = 0.74;
const METRIC_COLOR_SATURATION_END = 0.92;
const METRIC_COLOR_LIGHTNESS_START = 0.42;
const METRIC_COLOR_LIGHTNESS_END = 0.66;
const DEFAULT_NODE_SCALE_FALLBACK_MIN = 1.5;
const DEFAULT_NODE_SCALE_FALLBACK_MAX = 6;
const METRIC_NODE_SCALE_MIN_FACTOR = 0.75;
const METRIC_NODE_SCALE_MAX_FACTOR = 1.9;
const TOOLTIP_MARGIN = 14;
const TOOLTIP_MIN_WIDTH = 120;

const pathHighlightState = {
  showPrerequisites: true,
  showDependents: false,
};
let nodeColorMode = NODE_COLOR_MODE_CATEGORY;
let nodeSizeMode = NODE_SIZE_MODE_DEFAULT;
let metricRangeMap = new Map();
let defaultNodeScaleMap = new Map();
let defaultNodeScaleRange = {
  min: DEFAULT_NODE_SCALE_FALLBACK_MIN,
  max: DEFAULT_NODE_SCALE_FALLBACK_MAX,
};

window.addEventListener('resize', () => {
  if (!hoveredNodeId) return;
  updateHoverTooltipGeometry();
});

// --- Bootstrap ---

async function init() {
  try {
    graph = await loadGraph('./knowledge_graph.json');
    metricRangeMap = computeMetricRanges(graph.nodes);
    cacheDefaultNodeScales(graph.nodes);
  } catch (err) {
    document.body.innerHTML = `<div style="color:#f88;padding:40px;font-family:sans-serif">
      <h2>Failed to load knowledge graph</h2><p>${err.message}</p></div>`;
    return;
  }

  container = document.getElementById('canvas-container');
  Renderer.initRenderer(container);
  Renderer.createNodes(graph.nodes);
  Renderer.createEdges(graph.edges, graph.nodes);

  // Compute initial force layout
  const forcePositions = computeForceLayout(graph.nodes, graph.edges);
  applyPositions(forcePositions);
  Renderer.updatePositions();
  applyAmbientGraphStyle();
  Renderer.fitCameraToGraph();

  // Wire up interaction
  setupInteraction(container, Renderer.getNodeAtScreen, {
    onHover: handleHover,
    onClick: handleClick,
    onDblClick: handleDblClick,
    onEmptyClick: handleEmptyClick,
  });

  // Wire up UI
  UI.updateStats(graph.nodes.length, graph.edges.length);
  UI.setupSearch(handleSearch);
  UI.setupLayoutSelector(handleLayoutChange);
  UI.setupAutoRotate((enabled) => Renderer.setAutoRotate(enabled));
  UI.setupSettingsPanel();
  UI.setupNodeColoring(handleNodeColoringModeChange);
  UI.setupNodeSizing(handleNodeSizingModeChange);
  UI.setupInfoPanels();
  UI.setupPathHighlightToggles(handlePathHighlightToggleChange);
  UI.setPathHighlightToggleState(pathHighlightState);
  UI.setPathHighlightToggleEnabled(false);
  UI.setupLegend(getSortedCategories(), getCategoryColorHex, handleCategoryClick);
  UI.setupControlsHint();

  // Growth features
  UI.setupShareButtons(
    () => selectedNodeId,
    () => {
      if (!selectedNodeId) return null;
      if (selectedNodeIds.size > 1) {
        return `${selectedNodeIds.size} selected concepts`;
      }
      return graph.nodeMap.get(selectedNodeId)?.label ?? null;
    }
  );
  UI.setupScreenshotButton(() => Renderer.captureScreenshot());

  // Handle deep-link on load
  const hashNodeId = UI.getNodeIdFromHash();
  if (hashNodeId && graph.nodeMap.has(hashNodeId)) {
    // Delay slightly so layout is settled
    setTimeout(() => handleClick(hashNodeId), 300);
  }

  Renderer.startRenderLoop();
}

function applyPositions(positions) {
  for (const node of graph.nodes) {
    const pos = positions.get(node.id);
    if (pos) { node.x = pos.x; node.y = pos.y; node.z = pos.z; }
  }
}

function computeMetricRanges(nodes) {
  const ranges = new Map();
  for (const key of NODE_METRIC_KEYS) {
    ranges.set(key, {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    });
  }

  for (const node of nodes) {
    for (const key of NODE_METRIC_KEYS) {
      const value = node[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const range = ranges.get(key);
      range.min = Math.min(range.min, value);
      range.max = Math.max(range.max, value);
    }
  }

  for (const key of NODE_METRIC_KEYS) {
    const range = ranges.get(key);
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      ranges.set(key, { min: 0, max: 1 });
    }
  }

  return ranges;
}

function cacheDefaultNodeScales(nodes) {
  defaultNodeScaleMap = new Map();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const scale = typeof node._baseScale === 'number' && Number.isFinite(node._baseScale)
      ? node._baseScale
      : DEFAULT_NODE_SCALE_FALLBACK_MIN;
    defaultNodeScaleMap.set(node.id, scale);
    min = Math.min(min, scale);
    max = Math.max(max, scale);
  }

  defaultNodeScaleRange = {
    min: Number.isFinite(min) ? min : DEFAULT_NODE_SCALE_FALLBACK_MIN,
    max: Number.isFinite(max) ? max : DEFAULT_NODE_SCALE_FALLBACK_MAX,
  };
}

function isSupportedNodeColorMode(mode) {
  return mode === NODE_COLOR_MODE_CATEGORY || NODE_METRIC_KEYS.includes(mode);
}

function isSupportedNodeSizeMode(mode) {
  return mode === NODE_SIZE_MODE_DEFAULT || NODE_METRIC_KEYS.includes(mode);
}

function normalizeMetricValue(metricKey, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  const range = metricRangeMap.get(metricKey);
  if (!range) return 0.5;
  const spread = range.max - range.min;
  if (!Number.isFinite(spread) || spread <= 0) return 0.5;
  const normalized = (value - range.min) / spread;
  return Math.max(0, Math.min(1, normalized));
}

function getScaledNodeBaseSize(metricKey, metricValue) {
  const normalizedValue = normalizeMetricValue(metricKey, metricValue);
  const metricMin = defaultNodeScaleRange.min * METRIC_NODE_SCALE_MIN_FACTOR;
  const metricMax = defaultNodeScaleRange.max * METRIC_NODE_SCALE_MAX_FACTOR;
  const spread = metricMax - metricMin;
  if (!Number.isFinite(spread) || spread <= 0) return metricMin;
  return metricMin + spread * normalizedValue;
}

function applyNodeSizingMode(mode) {
  if (!graph) return;

  if (mode === NODE_SIZE_MODE_DEFAULT) {
    for (const node of graph.nodes) {
      const defaultScale = defaultNodeScaleMap.get(node.id);
      if (typeof defaultScale !== 'number' || !Number.isFinite(defaultScale)) continue;
      node._baseScale = defaultScale;
      node.radius = defaultScale;
    }
    return;
  }

  for (const node of graph.nodes) {
    const scale = getScaledNodeBaseSize(mode, node[mode]);
    node._baseScale = scale;
    node.radius = scale;
  }
}

function getMetricColor(normalizedValue) {
  const t = Math.max(0, Math.min(1, normalizedValue));
  return {
    h: METRIC_COLOR_HUE_START + (METRIC_COLOR_HUE_END - METRIC_COLOR_HUE_START) * t,
    s: METRIC_COLOR_SATURATION_START
      + (METRIC_COLOR_SATURATION_END - METRIC_COLOR_SATURATION_START) * t,
    l: METRIC_COLOR_LIGHTNESS_START
      + (METRIC_COLOR_LIGHTNESS_END - METRIC_COLOR_LIGHTNESS_START) * t,
  };
}

function getNodeBaseColor(node) {
  if (nodeColorMode === NODE_COLOR_MODE_CATEGORY) {
    return getCategoryColor(node.category);
  }

  const normalizedValue = normalizeMetricValue(nodeColorMode, node[nodeColorMode]);
  return getMetricColor(normalizedValue);
}

function getNodeAccentColor(node) {
  return getCategoryColorHex(node.category);
}

function hasActiveSelection() {
  return selectedNodeIds.size > 0;
}

function getSelectionContext(nodeIds = selectedNodeIds) {
  const selectedNodeSet = new Set();
  const prerequisiteSet = new Set();
  const dependentSet = new Set();
  if (!graph) return { selectedNodeSet, prerequisiteSet, dependentSet };

  for (const nodeId of nodeIds) {
    if (graph.nodeMap.has(nodeId)) {
      selectedNodeSet.add(nodeId);
    }
  }

  for (const nodeId of selectedNodeSet) {
    const upstream = getUpstream(nodeId, graph.nodeMap);
    for (const upstreamId of upstream) prerequisiteSet.add(upstreamId);

    const downstream = getDownstream(nodeId, graph.nodeMap);
    for (const downstreamId of downstream) dependentSet.add(downstreamId);
  }

  return { selectedNodeSet, prerequisiteSet, dependentSet };
}

function getSortedNodesByIds(nodeIdSet) {
  return [...nodeIdSet]
    .map((id) => graph.nodeMap.get(id))
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function getExternalNeighborNodeList(selectedNodeSet, relationKey) {
  const neighborIds = new Set();
  for (const nodeId of selectedNodeSet) {
    const node = graph.nodeMap.get(nodeId);
    if (!node) continue;
    for (const relatedId of node[relationKey]) {
      if (selectedNodeSet.has(relatedId)) continue;
      if (graph.nodeMap.has(relatedId)) neighborIds.add(relatedId);
    }
  }
  return getSortedNodesByIds(neighborIds);
}

function countOutsideSelection(nodeSet, selectionSet) {
  let count = 0;
  for (const nodeId of nodeSet) {
    if (!selectionSet.has(nodeId)) count += 1;
  }
  return count;
}

function updateSelectionInfoPanel(selectionContext) {
  const { selectedNodeSet, prerequisiteSet, dependentSet } = selectionContext;
  if (selectedNodeSet.size === 0) {
    UI.hideInfoPanel();
    return;
  }

  if (selectedNodeSet.size === 1) {
    const nodeId = selectedNodeSet.values().next().value;
    const node = graph.nodeMap.get(nodeId);
    if (!node) return;

    const directPrereqs = node.from
      .map((id) => graph.nodeMap.get(id))
      .filter(Boolean)
      .sort((a, b) => a.label.localeCompare(b.label));
    const directDeps = node.to
      .map((id) => graph.nodeMap.get(id))
      .filter(Boolean)
      .sort((a, b) => a.label.localeCompare(b.label));

    UI.showInfoPanel(
      node,
      prerequisiteSet.size - 1,
      dependentSet.size - 1,
      directPrereqs,
      directDeps,
      getNodeAccentColor(node),
      getCategoryColorHex,
      (clickedId) => handleClick(clickedId),
      (cat) => {
        UI.setSearchValue(cat);
        handleSearch(cat);
      },
    );
    return;
  }

  const selectedNodes = getSortedNodesByIds(selectedNodeSet);
  const directPrereqs = getExternalNeighborNodeList(selectedNodeSet, 'from');
  const directDeps = getExternalNeighborNodeList(selectedNodeSet, 'to');
  const prerequisiteCount = countOutsideSelection(prerequisiteSet, selectedNodeSet);
  const dependentCount = countOutsideSelection(dependentSet, selectedNodeSet);

  UI.showSelectionGroupPanel({
    selectedNodes,
    prerequisiteCount,
    dependentCount,
    directPrereqs,
    directDeps,
    onNodeClick: (clickedId) => handleClick(clickedId),
  });
}

function refreshCurrentVisualState() {
  if (!graph) return;

  const selectionContext = getSelectionContext();
  if (selectionContext.selectedNodeSet.size > 0) {
    selectedNodeIds = selectionContext.selectedNodeSet;
    if (!selectedNodeId || !selectedNodeIds.has(selectedNodeId)) {
      selectedNodeId = selectedNodeIds.values().next().value ?? null;
    }
    applySelectionHighlight(selectionContext, { animateCamera: false });
    return;
  }

  const query = document.getElementById('search').value.trim();
  if (query) {
    applySearchState(query, false);
    return;
  }

  applyAmbientGraphStyle();
  Renderer.updatePositions();
}

function handleNodeColoringModeChange(nextMode) {
  if (!isSupportedNodeColorMode(nextMode) || nextMode === nodeColorMode) return;
  nodeColorMode = nextMode;
  refreshCurrentVisualState();
}

function handleNodeSizingModeChange(nextMode) {
  if (!isSupportedNodeSizeMode(nextMode) || nextMode === nodeSizeMode) return;
  nodeSizeMode = nextMode;
  applyNodeSizingMode(nodeSizeMode);
  refreshCurrentVisualState();
}

// --- Hover ---

function handleHover(nodeId, screenX, screenY) {
  if (hoveredNodeId === nodeId) {
    if (nodeId) {
      positionHoverTooltip(screenX, screenY);
    }
    return;
  }

  // Restore previous hover
  if (hoveredNodeId && !hasActiveSelection()) {
    const prev = graph.nodeMap.get(hoveredNodeId);
    if (prev) {
      prev._currentScale = prev._hoverRestoreScale ?? prev._baseScale;
      prev._hoverRestoreScale = null;
    }
  }

  hoveredNodeId = nodeId;

  if (nodeId) {
    const node = graph.nodeMap.get(nodeId);
    if (tooltipLabel) {
      tooltipLabel.textContent = node.label;
      updateHoverTooltipGeometry();
    }
    positionHoverTooltip(screenX, screenY);
    tooltip.classList.add('visible');
    tooltip.setAttribute('aria-hidden', 'false');

    if (!hasActiveSelection()) {
      node._hoverRestoreScale = node._currentScale;
      node._currentScale = node._currentScale * 1.35;
      Renderer.updatePositions();
    }

    container.style.cursor = 'pointer';
  } else {
    tooltip.classList.remove('visible');
    tooltip.setAttribute('aria-hidden', 'true');
    if (!hasActiveSelection()) Renderer.updatePositions();
    container.style.cursor = 'default';
  }
}

function updateHoverTooltipGeometry() {
  if (!tooltip || !tooltipLabel || !tooltipShape || !tooltipBackdropPath || !tooltipConnectorPath) {
    return;
  }

  const labelX = 42;
  const labelY = 16;
  const labelWidth = Math.max(1, Math.ceil(tooltipLabel.offsetWidth));
  const labelHeight = Math.max(1, Math.ceil(tooltipLabel.offsetHeight));
  const baselineY = labelY + labelHeight + 2;
  const sourceX = 4;
  const sourceY = Math.max(7, baselineY - 34);
  const jointX = 22;
  const width = Math.ceil(labelX + labelWidth + 14);
  const height = Math.ceil(Math.max(labelY + labelHeight + 12, baselineY + 14));

  tooltip.style.setProperty('--tip-label-x', `${labelX}px`);
  tooltip.style.setProperty('--tip-label-y', `${labelY}px`);
  tooltip.style.width = `${width}px`;
  tooltip.style.height = `${height}px`;

  tooltipShape.setAttribute('viewBox', `0 0 ${width} ${height}`);
  tooltipShape.setAttribute('width', `${width}`);
  tooltipShape.setAttribute('height', `${height}`);

  const connectorPath = [
    `M ${sourceX} ${sourceY}`,
    `L ${jointX} ${baselineY}`,
    `L ${labelX} ${baselineY}`,
    `L ${labelX + labelWidth} ${baselineY}`,
  ].join(' ');
  tooltipConnectorPath.setAttribute('d', connectorPath);

  const inset = 1.5;
  const backdropPath = [
    `M ${inset} ${inset}`,
    `L ${width - inset} ${inset}`,
    `L ${width - inset} ${height - inset}`,
    `L ${inset} ${height - inset}`,
    'Z',
  ].join(' ');
  tooltipBackdropPath.setAttribute('d', backdropPath);

  const connectorLength = tooltipConnectorPath.getTotalLength();
  tooltipConnectorPath.style.setProperty('--path-len', `${connectorLength}`);
}

function positionHoverTooltip(screenX, screenY) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const tooltipWidth = Math.max(tooltip.offsetWidth, TOOLTIP_MIN_WIDTH);
  const tooltipHeight = Math.max(tooltip.offsetHeight, 46);

  let left = screenX + 6;
  let top = screenY - 6;

  left = Math.min(left, viewportWidth - tooltipWidth - TOOLTIP_MARGIN);
  left = Math.max(left, TOOLTIP_MARGIN);

  if (top + tooltipHeight + TOOLTIP_MARGIN > viewportHeight) {
    top = viewportHeight - tooltipHeight - TOOLTIP_MARGIN;
  }
  if (top < TOOLTIP_MARGIN) {
    top = TOOLTIP_MARGIN;
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

// --- Click: selection + path highlighting ---

function handleClick(nodeId, options = {}) {
  const {
    appendToSelection = false,
    animateCamera = true,
    updatePermalink = true,
  } = options;

  const node = graph.nodeMap.get(nodeId);
  if (!node) return;

  const shouldAppend = appendToSelection && hasActiveSelection();
  selectedNodeIds = shouldAppend
    ? new Set([...selectedNodeIds, nodeId])
    : new Set([nodeId]);
  selectedNodeId = nodeId;

  if (updatePermalink) {
    UI.updatePermalink(nodeId);
  }

  UI.enableRadialLayout(true);
  UI.setPathHighlightToggleEnabled(true);
  UI.setPathHighlightToggleState(pathHighlightState);

  const selectionContext = getSelectionContext(selectedNodeIds);
  selectedNodeIds = selectionContext.selectedNodeSet;
  applySelectionHighlight(selectionContext, {
    animateCamera: shouldAppend ? false : animateCamera,
    focusNodeId: nodeId,
  });
}

// --- Double-click: radial layout ---

async function handleDblClick(nodeId) {
  if (isAnimating) return;
  selectedNodeId = nodeId;
  selectedNodeIds = new Set([nodeId]);
  currentLayout = 'radial';
  UI.setActiveLayout('radial');
  UI.enableRadialLayout(true);

  const positions = computeRadialLayout(graph.nodes, nodeId, graph.nodeMap);
  isAnimating = true;
  Renderer.setAnimationPerformanceMode(true);
  try {
    let animationFrame = 0;
    await animateToPositions(
      graph.nodes,
      positions,
      ({ isFinalFrame }) => {
        animationFrame += 1;
        Renderer.updatePositions({
          updateArrows: false,
          updateEdges: isFinalFrame || animationFrame % 3 === 0,
        });
      },
      900
    );
  } finally {
    Renderer.setAnimationPerformanceMode(false);
    Renderer.updatePositions();
  }
  isAnimating = false;

  handleClick(nodeId, { animateCamera: false });
}

// --- Empty click: reset ---

function handleEmptyClick() {
  selectedNodeId = null;
  selectedNodeIds = new Set();
  hoveredNodeId = null;
  UI.updatePermalink(null);
  tooltip.classList.remove('visible');
  tooltip.setAttribute('aria-hidden', 'true');
  resetView();
  UI.hideInfoPanel();
  UI.setPathHighlightToggleEnabled(false);
  UI.enableRadialLayout(false);
}

function resetView() {
  applyAmbientGraphStyle();
  Renderer.updatePositions();
}

// --- Search (matches label OR category per spec §7.2) ---

function handleSearch(query) {
  if (!query) {
    selectedNodeId = null;
    selectedNodeIds = new Set();
    UI.hideInfoPanel();
    UI.setPathHighlightToggleEnabled(false);
    UI.enableRadialLayout(false);
    resetView();
    return;
  }

  selectedNodeId = null;
  selectedNodeIds = new Set();
  UI.hideInfoPanel();
  UI.setPathHighlightToggleEnabled(false);
  applySearchState(query, true);
}

function applySearchState(query, animateSingleMatchCamera) {
  const lower = query.toLowerCase();
  const matchIds = new Set();
  for (const n of graph.nodes) {
    if (n.label.toLowerCase().includes(lower) ||
        (n.category && n.category.toLowerCase().includes(lower))) {
      matchIds.add(n.id);
    }
  }

  const colorMap = new Map();
  for (const n of graph.nodes) {
    const baseColor = getNodeBaseColor(n);
    if (matchIds.has(n.id)) {
      colorMap.set(n.id, { ...baseColor, a: 1 });
      n._currentScale = n._baseScale * 1.14;
    } else {
      colorMap.set(n.id, { ...baseColor, a: SEARCH_NON_MATCH_OPACITY });
      n._currentScale = n._baseScale * 0.82;
    }
    n._hoverRestoreScale = null;
  }

  Renderer.updateColors(colorMap);
  Renderer.updatePositions();

  if (matchIds.size > 0 && matchIds.size < graph.nodes.length) {
    Renderer.setEdgeOpacity(SEARCH_EDGE_OPACITY);
    Renderer.showHighlightEdges(matchIds, SEARCH_EDGE_COLOR);
  } else {
    Renderer.setEdgeOpacity(BASE_EDGE_OPACITY);
    Renderer.clearHighlightEdges();
  }

  if (animateSingleMatchCamera && matchIds.size === 1) {
    const id = matchIds.values().next().value;
    const n = graph.nodeMap.get(id);
    Renderer.animateCamera(n.x, n.y, n.z);
  }
}

function applyAmbientGraphStyle() {
  const colorMap = new Map();
  for (const n of graph.nodes) {
    const baseColor = getNodeBaseColor(n);
    colorMap.set(n.id, { ...baseColor, a: 1 });
    n._currentScale = n._baseScale;
    n._hoverRestoreScale = null;
  }
  Renderer.updateColors(colorMap);
  Renderer.setEdgeOpacity(BASE_EDGE_OPACITY);
  Renderer.clearHighlightEdges();
}

function handlePathHighlightToggleChange(nextState) {
  pathHighlightState.showPrerequisites = nextState.showPrerequisites;
  pathHighlightState.showDependents = nextState.showDependents;
  if (!graph || !hasActiveSelection()) return;

  const selectionContext = getSelectionContext();
  selectedNodeIds = selectionContext.selectedNodeSet;
  if (!selectedNodeId || !selectedNodeIds.has(selectedNodeId)) {
    selectedNodeId = selectedNodeIds.values().next().value ?? null;
  }
  applySelectionHighlight(selectionContext, { animateCamera: false });
}

function applySelectionHighlight(selectionContext, options = {}) {
  const {
    animateCamera = false,
    focusNodeId = selectedNodeId,
  } = options;
  const {
    selectedNodeSet,
    prerequisiteSet,
    dependentSet,
  } = selectionContext;
  if (selectedNodeSet.size === 0) return;

  const activeNodeSet = new Set(selectedNodeSet);
  if (pathHighlightState.showPrerequisites) {
    for (const id of prerequisiteSet) activeNodeSet.add(id);
  }
  if (pathHighlightState.showDependents) {
    for (const id of dependentSet) activeNodeSet.add(id);
  }

  const colorMap = new Map();
  for (const n of graph.nodes) {
    const isSelected = selectedNodeSet.has(n.id);
    const isActive = activeNodeSet.has(n.id);
    const baseColor = isActive ? getCategoryColor(n.category) : getNodeBaseColor(n);
    colorMap.set(n.id, {
      ...baseColor,
      a: isActive ? 1 : NON_FOCUS_NODE_OPACITY,
    });

    if (isSelected) {
      n._currentScale = n._baseScale * 1.18;
    } else if (isActive) {
      n._currentScale = n._baseScale * 1.04;
    } else {
      n._currentScale = n._baseScale * 0.82;
    }
    n._hoverRestoreScale = null;
  }

  const edgeGroups = [];
  if (pathHighlightState.showPrerequisites) {
    edgeGroups.push({ nodeSet: prerequisiteSet, colorHex: PREREQUISITES_EDGE_COLOR });
  }
  if (pathHighlightState.showDependents) {
    edgeGroups.push({ nodeSet: dependentSet, colorHex: DEPENDENTS_EDGE_COLOR });
  }

  Renderer.updateColors(colorMap);
  Renderer.updatePositions();
  Renderer.setEdgeOpacity(SELECTED_CONTEXT_EDGE_OPACITY);
  if (edgeGroups.length > 0) {
    Renderer.showHighlightEdgeGroups(edgeGroups);
  } else {
    Renderer.clearHighlightEdges();
  }
  updateSelectionInfoPanel(selectionContext);

  if (animateCamera) {
    const cameraNodeId = selectedNodeSet.has(focusNodeId)
      ? focusNodeId
      : selectedNodeId;
    const node = graph.nodeMap.get(cameraNodeId);
    if (node) Renderer.animateCamera(node.x, node.y, node.z);
  }
}

// --- Layout change ---

async function handleLayoutChange(layout) {
  if (isAnimating || layout === currentLayout) return;
  isAnimating = true;

  const preservedSelectedNodeId = selectedNodeId;
  const shouldPreserveSelection = selectedNodeIds.size > 0;
  const radialCenterNodeId = preservedSelectedNodeId && selectedNodeIds.has(preservedSelectedNodeId)
    ? preservedSelectedNodeId
    : selectedNodeIds.values().next().value ?? null;
  const preservedFilterQuery = document.getElementById('search').value.trim();
  const shouldPreserveFilter = !shouldPreserveSelection && Boolean(preservedFilterQuery);

  if (shouldPreserveSelection) {
    hoveredNodeId = null;
    tooltip.classList.remove('visible');
    tooltip.setAttribute('aria-hidden', 'true');
  } else if (shouldPreserveFilter) {
    hoveredNodeId = null;
    tooltip.classList.remove('visible');
    tooltip.setAttribute('aria-hidden', 'true');
    UI.hideInfoPanel();
  } else {
    handleEmptyClick();
  }

  let positions;
  switch (layout) {
    case 'force':
      positions = computeForceLayout(graph.nodes, graph.edges);
      break;
    case 'hierarchical':
      positions = computeHierarchicalLayout(graph.nodes);
      break;
    case 'cluster':
      positions = computeClusterLayout(graph.nodes);
      break;
    case 'radial':
      if (!radialCenterNodeId) { isAnimating = false; return; }
      positions = computeRadialLayout(graph.nodes, radialCenterNodeId, graph.nodeMap);
      break;
    default:
      isAnimating = false;
      return;
  }

  currentLayout = layout;
  UI.setActiveLayout(layout);

  Renderer.setAnimationPerformanceMode(true);
  try {
    let animationFrame = 0;
    await animateToPositions(
      graph.nodes,
      positions,
      ({ isFinalFrame }) => {
        animationFrame += 1;
        Renderer.updatePositions({
          updateArrows: false,
          updateEdges: isFinalFrame || animationFrame % 3 === 0,
        });
      },
      900
    );
  } finally {
    Renderer.setAnimationPerformanceMode(false);
    Renderer.updatePositions();
  }
  isAnimating = false;

  // Re-apply visuals from live state so cleared/changed selections are respected.
  refreshCurrentVisualState();
}

// --- Category click from legend or info panel ---

function handleCategoryClick(category) {
  UI.setSearchValue(category);
  handleSearch(category);
}

// --- Start ---
init();
