#!/usr/bin/env python3
"""
graph.py -- CLI for managing the ML/math knowledge graph.

Used by the build-knowledge-graph skill. Claude Code provides concept
decompositions; this script handles graph bookkeeping (IDs, edges, BFS depth).

Subcommands:
    init <path>                                    Create empty graph
    add-seeds <path> <s1> <s2> ...                 Add seed concepts at depth 0
    pending <path> [--limit N] [--max-depth D]     Show next unvisited concepts
    ingest <path> [--max-depth D]                  Read JSON decompositions from stdin
    finalize <path>                                Post-process and clean up
    stats <path>                                   Print graph statistics
"""

import argparse
import hashlib
import json
import os
import sys
from collections import Counter, deque


# Foundational concepts that need no further decomposition -- only the most
# primitive logical and set-theoretic bedrock.  Everything above this level
# (e.g. "function", "real numbers", "sequence", "limit") SHOULD be decomposed.
TERMINALS = frozenset({
    "set", "element", "natural numbers",
    "logical conjunction", "logical disjunction", "logical negation",
    "logical implication", "universal quantifier", "existential quantifier",
    "equality",
})


def label_to_id(label: str) -> str:
    """Deterministic 8-char hex ID from lowercase label."""
    return hashlib.sha256(label.lower().strip().encode()).hexdigest()[:8]


def norm(label: str) -> str:
    return label.lower().strip()


class Graph:
    def __init__(self, path: str):
        self.path = path
        self.nodes: dict[str, dict] = {}  # norm(label) -> node

    def load(self, compute_depths: bool = False):
        if os.path.exists(self.path):
            with open(self.path) as f:
                for node in json.load(f):
                    self.nodes[norm(node["label"])] = node
        self._normalize_edges()
        if compute_depths:
            self._compute_depths()

    def save(self):
        with open(self.path, "w") as f:
            json.dump(list(self.nodes.values()), f, indent=2)

    def _id_index(self) -> dict[str, dict]:
        return {node["id"]: node for node in self.nodes.values()}

    def _normalize_edges(self):
        id_set = {n["id"] for n in self.nodes.values()}
        for node in self.nodes.values():
            node["to"] = list(dict.fromkeys(e for e in node.get("to", []) if e in id_set))
            node["from"] = list(dict.fromkeys(e for e in node.get("from", []) if e in id_set))

    def _compute_depths(self):
        """
        Recompute node depth from graph structure only:
        depth(node) = 0 if no prerequisites, else 1 + max(depth(prereq)).
        Mirrors explorer depth logic and uses a cycle guard.
        """
        id_to_node = self._id_index()
        computing: set[str] = set()
        done: set[str] = set()

        def dfs(node_id: str) -> int:
            node = id_to_node.get(node_id)
            if node is None:
                return 0
            if node_id in done:
                return node.get("_depth", 0)
            if node_id in computing:
                return 0  # cycle guard

            computing.add(node_id)
            prereqs = [pid for pid in node.get("from", []) if pid in id_to_node]
            if not prereqs:
                depth = 0
            else:
                depth = 1 + max(dfs(pid) for pid in prereqs)
            node["_depth"] = depth
            done.add(node_id)
            computing.remove(node_id)
            return depth

        for node_id in sorted(id_to_node.keys(), key=lambda nid: id_to_node[nid]["label"]):
            dfs(node_id)

    def _compute_pagerank(
        self,
        *,
        damping: float = 0.85,
        max_iter: int = 100,
        tol: float = 1.0e-9,
    ) -> dict[str, float]:
        """Compute directed PageRank over prerequisite->dependent edges."""
        id_to_node = self._id_index()
        node_ids = sorted(id_to_node.keys(), key=lambda nid: id_to_node[nid]["label"])
        n = len(node_ids)
        if n == 0:
            return {}

        rank = {node_id: 1.0 / n for node_id in node_ids}
        out_degree = {
            node_id: len([tid for tid in id_to_node[node_id].get("to", []) if tid in id_to_node])
            for node_id in node_ids
        }

        for _ in range(max_iter):
            dangling_mass = sum(rank[node_id] for node_id in node_ids if out_degree[node_id] == 0)
            base = (1.0 - damping) / n + damping * dangling_mass / n
            next_rank = {node_id: base for node_id in node_ids}

            for target_id in node_ids:
                target = id_to_node[target_id]
                acc = 0.0
                for source_id in target.get("from", []):
                    if source_id not in rank:
                        continue
                    deg = out_degree[source_id]
                    if deg > 0:
                        acc += rank[source_id] / deg
                next_rank[target_id] += damping * acc

            delta = sum(abs(next_rank[node_id] - rank[node_id]) for node_id in node_ids)
            rank = next_rank
            if delta < tol:
                break

        return rank

    def _compute_degree_centrality(self) -> dict[str, float]:
        """
        Directed degree centrality normalized to [0, 1]:
        (in_degree + out_degree) / (2 * (n - 1)).
        """
        id_to_node = self._id_index()
        node_ids = sorted(id_to_node.keys(), key=lambda nid: id_to_node[nid]["label"])
        n = len(node_ids)
        if n <= 1:
            return {node_id: 0.0 for node_id in node_ids}

        denom = 2.0 * (n - 1)
        centrality: dict[str, float] = {}
        for node_id in node_ids:
            node = id_to_node[node_id]
            in_deg = len([sid for sid in node.get("from", []) if sid in id_to_node])
            out_deg = len([tid for tid in node.get("to", []) if tid in id_to_node])
            centrality[node_id] = (in_deg + out_deg) / denom
        return centrality

    def _compute_betweenness_centrality(self) -> dict[str, float]:
        """Compute directed, unweighted betweenness centrality via Brandes."""
        id_to_node = self._id_index()
        node_ids = sorted(id_to_node.keys(), key=lambda nid: id_to_node[nid]["label"])
        n = len(node_ids)
        if n == 0:
            return {}

        betweenness = {node_id: 0.0 for node_id in node_ids}

        for source_id in node_ids:
            stack: list[str] = []
            predecessors: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
            sigma = {node_id: 0.0 for node_id in node_ids}
            sigma[source_id] = 1.0
            distance = {source_id: 0}
            queue: deque[str] = deque([source_id])

            while queue:
                v = queue.popleft()
                stack.append(v)
                v_dist = distance[v]
                for w in id_to_node[v].get("to", []):
                    if w not in id_to_node:
                        continue
                    if w not in distance:
                        distance[w] = v_dist + 1
                        queue.append(w)
                    if distance[w] == v_dist + 1:
                        sigma[w] += sigma[v]
                        predecessors[w].append(v)

            dependency = {node_id: 0.0 for node_id in node_ids}
            while stack:
                w = stack.pop()
                sigma_w = sigma[w]
                if sigma_w > 0:
                    for v in predecessors[w]:
                        dependency[v] += (sigma[v] / sigma_w) * (1.0 + dependency[w])
                if w != source_id:
                    betweenness[w] += dependency[w]

        if n > 2:
            scale = 1.0 / ((n - 1) * (n - 2))
            for node_id in node_ids:
                betweenness[node_id] *= scale
        else:
            for node_id in node_ids:
                betweenness[node_id] = 0.0

        return betweenness

    def _compute_reachability_ratios(self) -> dict[str, dict[str, float]]:
        """
        Compute:
        - _descendant_ratio: descendants / (# nodes with higher depth)
        - _prerequisite_ratio: prerequisites / (# nodes with lower depth)
        - _reachability_ratio: (descendants + prerequisites) / total nodes
        """
        id_to_node = self._id_index()
        node_ids = sorted(id_to_node.keys(), key=lambda nid: id_to_node[nid]["label"])
        n = len(node_ids)
        if n == 0:
            return {}

        # Ensure depths exist for denominator calculations.
        if any("_depth" not in node for node in id_to_node.values()):
            self._compute_depths()
            id_to_node = self._id_index()

        depth_hist = Counter(node.get("_depth", 0) for node in id_to_node.values())
        ordered_depths = sorted(depth_hist.keys())
        lower_count_by_depth: dict[int, int] = {}
        running = 0
        for depth in ordered_depths:
            lower_count_by_depth[depth] = running
            running += depth_hist[depth]
        higher_count_by_depth = {
            depth: n - lower_count_by_depth[depth] - depth_hist[depth]
            for depth in ordered_depths
        }

        def reachable_count(start_id: str, edge_key: str) -> int:
            seen: set[str] = set()
            queue: deque[str] = deque(id_to_node[start_id].get(edge_key, []))
            while queue:
                next_id = queue.popleft()
                if next_id in seen or next_id not in id_to_node:
                    continue
                seen.add(next_id)
                queue.extend(id_to_node[next_id].get(edge_key, []))
            return len(seen)

        ratios: dict[str, dict[str, float]] = {}
        for node_id in node_ids:
            node = id_to_node[node_id]
            depth = node.get("_depth", 0)
            descendants = reachable_count(node_id, "to")
            prerequisites = reachable_count(node_id, "from")
            higher_total = higher_count_by_depth.get(depth, 0)
            lower_total = lower_count_by_depth.get(depth, 0)
            descendant_ratio = (descendants / higher_total) if higher_total > 0 else 0.0
            prerequisite_ratio = (prerequisites / lower_total) if lower_total > 0 else 0.0
            reachability_ratio = (descendants + prerequisites) / n
            ratios[node_id] = {
                "_descendant_ratio": descendant_ratio,
                "_prerequisite_ratio": prerequisite_ratio,
                "_reachability_ratio": reachability_ratio,
            }

        return ratios

    def compute_node_metrics(self):
        """Compute and attach all requested node-level graph metrics."""
        self._normalize_edges()
        self._compute_depths()

        id_to_node = self._id_index()
        pagerank = self._compute_pagerank()
        degree_centrality = self._compute_degree_centrality()
        betweenness_centrality = self._compute_betweenness_centrality()
        reachability_ratios = self._compute_reachability_ratios()

        for node_id, node in id_to_node.items():
            node["_pagerank"] = pagerank.get(node_id, 0.0)
            node["_degree_centrality"] = degree_centrality.get(node_id, 0.0)
            node["_betweenness_centrality"] = betweenness_centrality.get(node_id, 0.0)
            node["_descendant_ratio"] = reachability_ratios.get(node_id, {}).get("_descendant_ratio", 0.0)
            node["_prerequisite_ratio"] = reachability_ratios.get(node_id, {}).get("_prerequisite_ratio", 0.0)
            node["_reachability_ratio"] = reachability_ratios.get(node_id, {}).get("_reachability_ratio", 0.0)

    def _remove_orphan_stubs(self) -> int:
        """Remove nodes with no edges and no definition."""
        to_remove = [
            k for k, n in self.nodes.items()
            if not n["to"] and not n["from"] and not n.get("definition")
        ]
        for k in to_remove:
            del self.nodes[k]
        return len(to_remove)

    def _has_path(
        self,
        source_id: str,
        target_id: str,
        *,
        id_to_node: dict[str, dict],
        skip_edge: tuple[str, str] | None = None,
        allowed_ids: set[str] | None = None,
    ) -> bool:
        queue: deque[str] = deque([source_id])
        seen = {source_id}

        while queue:
            current_id = queue.popleft()
            current = id_to_node.get(current_id)
            if current is None:
                continue
            for next_id in current.get("to", []):
                if skip_edge and current_id == skip_edge[0] and next_id == skip_edge[1]:
                    continue
                if allowed_ids is not None and next_id not in allowed_ids:
                    continue
                if next_id == target_id:
                    return True
                if next_id not in seen:
                    seen.add(next_id)
                    queue.append(next_id)
        return False

    def _strongly_connected_components(self, id_to_node: dict[str, dict]) -> list[list[str]]:
        """Tarjan SCC decomposition over node IDs."""
        index = 0
        indices: dict[str, int] = {}
        lowlink: dict[str, int] = {}
        stack: list[str] = []
        on_stack: set[str] = set()
        components: list[list[str]] = []

        def strongconnect(node_id: str):
            nonlocal index
            indices[node_id] = index
            lowlink[node_id] = index
            index += 1
            stack.append(node_id)
            on_stack.add(node_id)

            node = id_to_node[node_id]
            neighbors = sorted(
                (nid for nid in node.get("to", []) if nid in id_to_node),
                key=lambda nid: id_to_node[nid]["label"],
            )
            for next_id in neighbors:
                if next_id not in indices:
                    strongconnect(next_id)
                    lowlink[node_id] = min(lowlink[node_id], lowlink[next_id])
                elif next_id in on_stack:
                    lowlink[node_id] = min(lowlink[node_id], indices[next_id])

            if lowlink[node_id] == indices[node_id]:
                component: list[str] = []
                while True:
                    popped = stack.pop()
                    on_stack.remove(popped)
                    component.append(popped)
                    if popped == node_id:
                        break
                components.append(component)

        ordered_ids = sorted(id_to_node.keys(), key=lambda nid: id_to_node[nid]["label"])
        for node_id in ordered_ids:
            if node_id not in indices:
                strongconnect(node_id)
        return components

    def _has_cycle(self, id_to_node: dict[str, dict]) -> bool:
        for component in self._strongly_connected_components(id_to_node):
            if len(component) > 1:
                return True
            node_id = component[0]
            node = id_to_node[node_id]
            if node_id in node.get("to", []):
                return True
        return False

    def ensure(self, label: str, depth: int | None = None) -> dict:
        """Get or create a node. Updates depth if the new depth is shallower."""
        key = norm(label)
        if key not in self.nodes:
            self.nodes[key] = {
                "id": label_to_id(key),
                "label": key,
                "to": [],
                "from": [],
                "category": "",
                "definition": "",
                "long_description": "",
                "_depth": depth if depth is not None else 999,
            }
        elif depth is not None and depth < self.nodes[key].get("_depth", 999):
            self.nodes[key]["_depth"] = depth
        return self.nodes[key]

    def add_edge(self, prereq_label: str, dependent_label: str):
        """Add directed edge: prereq is used BY dependent."""
        p = self.ensure(prereq_label)
        d = self.ensure(dependent_label)
        if d["id"] not in p["to"]:
            p["to"].append(d["id"])
        if p["id"] not in d["from"]:
            d["from"].append(p["id"])

    def visited(self) -> set[str]:
        return {k for k, v in self.nodes.items() if v.get("definition")}

    def pending(self, limit: int = 20, max_depth: int = 100) -> list[str]:
        """Return unvisited, non-terminal nodes sorted by BFS depth."""
        vis = self.visited()
        candidates = sorted(
            ((k, v) for k, v in self.nodes.items()
             if k not in vis
             and k not in TERMINALS
             and v.get("_depth", 0) <= max_depth),
            key=lambda kv: kv[1].get("_depth", 999),
        )
        return [k for k, _ in candidates[:limit]]

    def ingest(self, decompositions: list[dict], max_depth: int = 100) -> int:
        """Add a batch of decomposed concepts. Returns count added."""
        added = 0
        for item in decompositions:
            label = norm(item["label"])
            node = self.ensure(label)
            node["definition"] = item.get("definition", "")
            node["long_description"] = item.get("long_description", "")
            node["category"] = item.get("category", "")
            parent_depth = node.get("_depth", 0)

            for prereq in item.get("prerequisites", []):
                prereq = norm(prereq)
                if prereq and prereq != label:
                    child_depth = parent_depth + 1
                    if child_depth <= max_depth:
                        self.ensure(prereq, depth=child_depth)
                    self.add_edge(prereq, label)
            added += 1
        return added

    def eliminate_cycles(self) -> int:
        """
        Break all directed cycles by removing one internal edge per cyclic SCC,
        prioritizing larger depth drop, then alternate-path-preserving removals.
        """
        removed = 0

        while True:
            id_to_node = self._id_index()
            components = self._strongly_connected_components(id_to_node)
            cyclic_components: list[list[str]] = []
            for component in components:
                if len(component) > 1:
                    cyclic_components.append(component)
                    continue
                node_id = component[0]
                if node_id in id_to_node[node_id].get("to", []):
                    cyclic_components.append(component)

            if not cyclic_components:
                break

            changed = False
            for component in cyclic_components:
                component_ids = set(component)
                candidates = []

                for source_id in sorted(component_ids, key=lambda nid: id_to_node[nid]["label"]):
                    source = id_to_node[source_id]
                    for target_id in sorted(
                        (tid for tid in source.get("to", []) if tid in component_ids),
                        key=lambda nid: id_to_node[nid]["label"],
                    ):
                        depth_drop = source.get("_depth", 999) - id_to_node[target_id].get("_depth", 999)
                        has_alt_path = self._has_path(
                            source_id,
                            target_id,
                            id_to_node=id_to_node,
                            skip_edge=(source_id, target_id),
                            allowed_ids=component_ids,
                        )
                        candidates.append(
                            (
                                -depth_drop,               # prefer larger depth drop
                                0 if has_alt_path else 1,  # prefer preserving reachability
                                source["label"],
                                id_to_node[target_id]["label"],
                                source_id,
                                target_id,
                            )
                        )

                if not candidates:
                    continue

                _, _, _, _, source_id, target_id = min(candidates)
                source = id_to_node[source_id]
                target = id_to_node[target_id]
                source["to"] = [nid for nid in source.get("to", []) if nid != target_id]
                target["from"] = [nid for nid in target.get("from", []) if nid != source_id]
                removed += 1
                changed = True

            if not changed:
                break

        self._normalize_edges()
        return removed

    def transitive_reduction(self) -> int:
        """
        Remove all transitive edges in a DAG:
        remove u->v when an alternate path u=>v exists without that edge.
        """
        id_to_node = self._id_index()
        if self._has_cycle(id_to_node):
            raise ValueError("transitive_reduction requires a DAG; call eliminate_cycles first")

        removed = 0
        ordered_ids = sorted(id_to_node.keys(), key=lambda nid: id_to_node[nid]["label"])

        for source_id in ordered_ids:
            source = id_to_node[source_id]
            outgoing = list(source.get("to", []))
            if len(outgoing) < 2:
                continue

            for target_id in outgoing:
                if target_id not in source.get("to", []):
                    continue
                if self._has_path(
                    source_id,
                    target_id,
                    id_to_node=id_to_node,
                    skip_edge=(source_id, target_id),
                ):
                    source["to"] = [nid for nid in source.get("to", []) if nid != target_id]
                    target = id_to_node.get(target_id)
                    if target is not None:
                        target["from"] = [nid for nid in target.get("from", []) if nid != source_id]
                    removed += 1

        self._normalize_edges()
        return removed

    def postprocess(self):
        """
        Clean graph and enforce DAG form.

        Metrics are computed on the complete DAG (after cycle elimination,
        before transitive reduction), then the graph is transitively reduced.
        """
        self._normalize_edges()
        self.eliminate_cycles()
        self._normalize_edges()
        self._remove_orphan_stubs()
        self.compute_node_metrics()
        self.transitive_reduction()
        self._normalize_edges()
        self._remove_orphan_stubs()
        # Strip internal bookkeeping fields
        for node in self.nodes.values():
            node.pop("_depth", None)
        id_to_node = self._id_index()
        if self._has_cycle(id_to_node):
            raise RuntimeError("postprocess expected a DAG, but cycles remain")
        # Sort: roots first, then alphabetical
        sorted_nodes = sorted(
            self.nodes.values(),
            key=lambda n: (len(n["from"]), n["label"]),
        )
        self.nodes = {norm(n["label"]): n for n in sorted_nodes}


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------

def cmd_init(args):
    with open(args.path, "w") as f:
        json.dump([], f)
    print(f"Initialized: {args.path}")


def cmd_add_seeds(args):
    g = Graph(args.path)
    g.load(compute_depths=True)
    for s in args.seeds:
        g.ensure(s, depth=0)
    g.save()
    print(f"Seeds: {', '.join(args.seeds)}. Total nodes: {len(g.nodes)}")


def cmd_pending(args):
    g = Graph(args.path)
    g.load(compute_depths=True)
    vis = g.visited()
    pending = g.pending(limit=args.limit, max_depth=args.max_depth)
    print(f"Graph: {len(g.nodes)} nodes, {len(vis)} visited, {len(pending)} pending (showing <= {args.limit})")
    if not pending:
        print("NO_PENDING")
    else:
        for label in pending:
            d = g.nodes[label].get("_depth", "?")
            print(f"  - {label}  [depth={d}]")


def cmd_ingest(args):
    g = Graph(args.path)
    g.load(compute_depths=True)
    data = json.load(sys.stdin)
    if not isinstance(data, list):
        data = [data]
    added = g.ingest(data, max_depth=args.max_depth)
    g.save()
    vis = g.visited()
    pending = g.pending(limit=99999, max_depth=args.max_depth)
    print(f"Ingested {added} node(s). Total: {len(g.nodes)} nodes, {len(vis)} visited, {len(pending)} pending")


def cmd_finalize(args):
    g = Graph(args.path)
    g.load(compute_depths=True)
    before = len(g.nodes)
    g.postprocess()
    g.save()
    after = len(g.nodes)
    edges = sum(len(n["to"]) for n in g.nodes.values())
    print(f"Finalized: {after} nodes ({before - after} orphans removed), {edges} edges")


def cmd_stats(args):
    g = Graph(args.path)
    g.load(compute_depths=True)
    nodes = list(g.nodes.values())
    n = len(nodes)
    e = sum(len(nd["to"]) for nd in nodes)
    vis = len(g.visited())
    pend = len(g.pending(limit=99999, max_depth=args.max_depth))
    roots = sum(1 for nd in nodes if not nd["from"])
    leaves = sum(1 for nd in nodes if not nd["to"])
    cats = Counter(nd.get("category", "") for nd in nodes if nd.get("category"))

    print(f"Nodes: {n}  (visited: {vis}, pending: {pend})")
    print(f"Edges: {e}")
    print(f"Roots: {roots}  Leaves: {leaves}")
    if cats:
        print(f"\nTop categories:")
        for cat, cnt in cats.most_common(25):
            print(f"  {cat}: {cnt}")
    if nodes:
        print(f"\nTop prerequisite nodes (most dependents):")
        by_dep = sorted(nodes, key=lambda nd: len(nd["to"]), reverse=True)[:10]
        for nd in by_dep:
            if nd["to"]:
                print(f"  {nd['label']}: {len(nd['to'])} dependents")


def main():
    p = argparse.ArgumentParser(description="Knowledge graph manager")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="Create empty graph file")
    s.add_argument("path")

    s = sub.add_parser("add-seeds", help="Add seed concepts")
    s.add_argument("path")
    s.add_argument("seeds", nargs="+")

    s = sub.add_parser("pending", help="Show unvisited concepts")
    s.add_argument("path")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--max-depth", type=int, default=100)

    s = sub.add_parser("ingest", help="Ingest decompositions from stdin")
    s.add_argument("path")
    s.add_argument("--max-depth", type=int, default=100)

    s = sub.add_parser("finalize", help="Post-process graph")
    s.add_argument("path")

    s = sub.add_parser("stats", help="Print statistics")
    s.add_argument("path")
    s.add_argument("--max-depth", type=int, default=100)

    args = p.parse_args()
    {"init": cmd_init, "add-seeds": cmd_add_seeds, "pending": cmd_pending,
     "ingest": cmd_ingest, "finalize": cmd_finalize, "stats": cmd_stats}[args.cmd](args)


if __name__ == "__main__":
    main()
