---
name: build-knowledge-graph
description: Recursively builds a knowledge graph of mathematical concepts and ML algorithms. Use when the user asks to "build a knowledge graph", "decompose concepts", "map dependencies between algorithms", or provides seed concepts for graph expansion. Each node is a precisely definable concept (algorithm, theorem, mathematical object) with prerequisite edges.
---

# Build Knowledge Graph

Recursively decompose ML algorithms and mathematical concepts into a directed knowledge graph. Each node is a **precisely definable concept** -- an algorithm, theorem, mathematical object, or operation (e.g. "eigenvalue", "transformer layer", "decision tree", "directed acyclic graph"). Nodes are **never** fields, disciplines, or vague terms.

The final graph must be a **DAG** (no directed cycles).

## Node format

```json
{
  "id": "a0237bba",
  "label": "singular value decomposition",
  "to": ["9f9d6c30", "d2155e0e"],
  "from": ["bf594ee2", "1c77c3c7"],
  "category": "Linear and multilinear algebra; matrix theory",
  "definition": "A factorization M = U S V^T where U, V are orthogonal and S is diagonal with non-negative entries...",
  "long_description": "The singular value decomposition (SVD) expresses any m × n real (or complex) matrix A as A = UΣV^T ...",
  "_depth": 3,
  "_pagerank": 0.00024,
  "_degree_centrality": 0.00120,
  "_betweenness_centrality": 0.0,
  "_descendant_ratio": 0.99759,
  "_prerequisite_ratio": 0.0,
  "_reachability_ratio": 0.99519
}
```

| Field | Description |
|-------|-------------|
| `id` | Deterministic 8-char hex SHA-256 of the lowercase label |
| `label` | Canonical lowercase name |
| `to` | IDs of nodes that **depend on** this concept (this node is a prerequisite OF those) |
| `from` | IDs of nodes this concept **depends on** (prerequisites OF this node) |
| `category` | MSC 2020 category (math) or CS task taxonomy (ML/CS) |
| `definition` | Precise mathematical definition (1-3 sentences) |
| `long_description` | Extended mathematical description (200-300 words) covering formal definition, key properties, theorems, relationships, and intuition |
| `_depth` | Internal structural depth (`0` for nodes with no prerequisites; otherwise `1 + max(prereq depth)`) |
| `_pagerank` | PageRank score on directed prerequisite graph |
| `_degree_centrality` | Normalized directed degree centrality |
| `_betweenness_centrality` | Directed betweenness centrality |
| `_descendant_ratio` | Descendant count divided by number of nodes at strictly higher depth |
| `_prerequisite_ratio` | Prerequisite count divided by number of nodes at strictly lower depth |
| `_reachability_ratio` | `(descendant count + prerequisite count) / total nodes` |

## Tool

```
python3 .claude/skills/build-knowledge-graph/scripts/graph.py <subcommand> [args]
```

| Subcommand | Purpose |
|------------|---------|
| `init <path>` | Create empty graph file |
| `add-seeds <path> <s1> <s2> ...` | Add seed concepts at depth 0 |
| `pending <path> [--limit N] [--max-depth D]` | Show next N unvisited concepts |
| `ingest <path> [--max-depth D]` | Read JSON decompositions from stdin, update graph |
| `finalize <path>` | Post-process and enforce DAG: eliminate cycles, compute metrics on complete DAG, transitive-reduce, remove orphans, deduplicate, sort |
| `stats <path>` | Print graph statistics |

## Workflow

### 1. Initialize

```bash
GRAPH="knowledge_graph.json"
GR="python3 .claude/skills/build-knowledge-graph/scripts/graph.py"

$GR init "$GRAPH"
$GR add-seeds "$GRAPH" "concept 1" "concept 2" "concept 3"
```

If a graph file already exists and the user wants to resume/extend, skip `init` and just run `pending` to see what remains.

### 2. Iterate: decompose pending concepts

Repeat until `pending` prints `NO_PENDING`:

**Step A** -- Get the next batch:
```bash
$GR pending "$GRAPH" --limit 10
```

**Step B** -- For **every** concept in the batch, produce a decomposition. Analyze them all at once. For each concept determine:

1. **Definition**: precise mathematical/algorithmic definition (1-3 sentences).
2. **Long description**: an extended mathematical description (200-300 words) covering the formal definition, key properties and theorems, relationship to other concepts, computational considerations, and intuition. Write at the level of a graduate mathematics or ML textbook. Use LaTeX-style notation for formulas.
3. **Prerequisites**: specific concepts **directly used in the definition**. Each must be a single, precisely definable concept. Use canonical lowercase names. Decompose deeply into mathematical foundations -- if a concept relies on "vector", "function", "real numbers", "limit", "supremum", etc., list them.
4. **Category**: one MSC 2020 top-level name (math) or one CS/ML task discipline (CS).

Format as a JSON array:
```json
[
  {
    "label": "concept name",
    "definition": "...",
    "long_description": "...",
    "prerequisites": ["prereq a", "prereq b"],
    "category": "Category Name"
  }
]
```

**Step C** -- Pipe the JSON into `ingest`:
```bash
cat <<'BATCH' | $GR ingest "$GRAPH"
[ ... JSON array ... ]
BATCH
```

**Step D** -- Read the `ingest` output to see how many nodes are pending. Go back to Step A.

### 3. Finalize

```bash
$GR finalize "$GRAPH"
$GR stats "$GRAPH"
```

Always run `finalize` before delivering results. `finalize` enforces that the resulting graph is a DAG (cycles removed + transitive reduction applied).
`finalize` also computes and saves node metrics on the complete DAG (after cycle elimination and before transitive reduction), then writes the reduced DAG.
The final saved graph must include `_pagerank`, `_degree_centrality`, `_betweenness_centrality`, `_descendant_ratio`, `_prerequisite_ratio`, and `_reachability_ratio` on every node.

Report the final node count, edge count, top categories, and confirm that node metrics were computed and saved from the complete graph.

## Concept decomposition rules

These rules are **critical** for graph quality:

1. **Nodes must be precise concepts**, not fields.
   - Yes: "matrix multiplication", "softmax function", "cross-entropy loss", "convolution"
   - No: "linear algebra", "calculus", "deep learning", "statistics"

2. **Prerequisites must appear in the definition**. Only list concepts that someone must understand to parse the definition. Do not list tangentially related concepts.

3. **Use canonical lowercase names**: "rectified linear unit", "batch normalization", "bayes theorem", "singular value decomposition".

4. **Terminal concepts** (do not decompose further -- the bare logical and set-theoretic bedrock): set, element, natural numbers, logical conjunction, logical disjunction, logical negation, logical implication, universal quantifier, existential quantifier, equality.

   Everything above this level **must** be decomposed. For example:
   - "logarithm" -> "inverse function", "exponential function"
   - "dot product" -> "vector", "multiplication", "summation"
   - "vector" -> "vector space"
   - "vector space" -> "field", "abelian group", "scalar multiplication"
   - "function" -> "relation", "domain", "codomain"
   - "relation" -> "ordered pair", "subset", "cartesian product"
   - "ordered pair" -> "set"
   - "real numbers" -> "complete ordered field", "dedekind cut" or "cauchy sequence"
   - "limit" -> "epsilon-delta definition", "real numbers", "absolute value"
   - "absolute value" -> "real numbers", "function"
   - "addition" -> "binary operation", "natural numbers" (then extends to integers, rationals, reals)
   - "multiplication" -> "binary operation", "natural numbers"
   - "summation" -> "addition", "index set", "sequence"
   - "sequence" -> "function", "natural numbers"

   The goal is a graph that bottoms out at foundational mathematics (set theory, logic, basic algebraic structures) rather than stopping at calculus-level concepts.

5. **No self-references**: a concept cannot list itself as a prerequisite.

6. **Prefer specificity**: "convolutional layer" decomposes into "convolution", "activation function", "bias vector" -- not into "neural network" or "deep learning".

7. **Result must be acyclic**: the final delivered graph must be a DAG. Always run `finalize` to enforce cycle elimination and transitive reduction.

## Formatting guidelines

Both `definition` and `long_description` are **Markdown strings** with **LaTeX math**. Follow these rules strictly:

### LaTeX math

- Use `$...$` for inline math and `$$...$$` for display math.
- All variable names, operators, and formulas must be in LaTeX, never plain ASCII math.
  - Yes: `$f(x) = \sum_{i=1}^{n} w_i x_i$`
  - No: `f(x) = sum_i w_i x_i` or `f(x) = Σ wᵢxᵢ`
- Use proper LaTeX commands for symbols:
  - Greek letters: `$\alpha$`, `$\beta$`, `$\Sigma$`, `$\epsilon$`, `$\theta$`, `$\lambda$`
  - Operators: `$\sum$`, `$\prod$`, `$\int$`, `$\nabla$`, `$\partial$`, `$\max$`, `$\min$`, `$\arg\max$`, `$\arg\min$`
  - Relations: `$\leq$`, `$\geq$`, `$\neq$`, `$\in$`, `$\subset$`, `$\subseteq$`, `$\forall$`, `$\exists$`, `$\implies$`, `$\iff$`
  - Decorations: `$\hat{y}$`, `$\bar{x}$`, `$\tilde{w}$`, `$\mathbf{x}$` (bold vectors), `$\mathbb{R}$` (number sets), `$\mathcal{L}$` (loss/Lagrangian)
  - Delimiters: `$\left( ... \right)$`, `$\| \mathbf{x} \|$` for norms
  - Text in math: `$\text{softmax}$`, `$\operatorname{ReLU}$`
- Use `\text{}` or `\operatorname{}` for multi-letter function names inside math mode — never bare words.
- Prefer `\lVert \cdot \rVert` or `\| \cdot \|` for norms, not `|| ||`.

### Markdown structure (for `long_description`)

- Use **bold** for key terms on first introduction.
- Use bullet lists for enumerating properties or variants.
- Separate logical sections (definition, properties, intuition) with line breaks.
- Keep paragraphs short (2-4 sentences each).
- Do **not** use headings (`#`, `##`) inside descriptions — the description is a single node's content.

### Example

**definition** (short):
```
"The **sigmoid function** is defined as $\\sigma(x) = \\frac{1}{1 + e^{-x}}$, mapping $\\mathbb{R} \\to (0, 1)$."
```

**long_description** (extended):
```
"The **sigmoid function** (also called the logistic function) is the smooth, monotonically increasing map $\\sigma : \\mathbb{R} \\to (0, 1)$ defined by\n\n$$\\sigma(x) = \\frac{1}{1 + e^{-x}}.$$\n\nIt arises naturally as the canonical link function for Bernoulli-distributed responses in generalized linear models, converting log-odds to probabilities.\n\n**Key properties:**\n\n- **Symmetry:** $\\sigma(-x) = 1 - \\sigma(x)$.\n- **Derivative:** $\\sigma'(x) = \\sigma(x)(1 - \\sigma(x))$, which is maximal at $x = 0$ (value $\\frac{1}{4}$) and vanishes as $|x| \\to \\infty$.\n- **Inverse:** The logit function $\\sigma^{-1}(p) = \\ln\\frac{p}{1-p}$.\n- **Limits:** $\\lim_{x \\to -\\infty} \\sigma(x) = 0$ and $\\lim_{x \\to +\\infty} \\sigma(x) = 1$.\n\nIn neural networks, the sigmoid was historically the default activation function but has been largely replaced by ReLU and its variants in hidden layers due to the **vanishing gradient problem**: for large $|x|$, $\\sigma'(x) \\approx 0$, causing gradients to shrink exponentially through deep layers during backpropagation.\n\nThe sigmoid remains standard in **output layers for binary classification**, where the output $\\sigma(\\mathbf{w}^\\top \\mathbf{x} + b)$ is interpreted as $P(y = 1 \\mid \\mathbf{x})$, and in **gating mechanisms** (LSTM, GRU, mixture of experts) where a value in $(0, 1)$ controls information flow.\n\nComputationally, care must be taken to evaluate $\\sigma$ in a numerically stable way, using $\\sigma(x) = e^x / (1 + e^x)$ for $x < 0$ and the standard form for $x \\geq 0$ to avoid overflow."
```

## Category taxonomy

**Mathematics** -- use MSC 2020 top-level category names:
- Combinatorics
- Number theory
- Linear and multilinear algebra; matrix theory
- Real functions
- Measure and integration
- Probability theory and stochastic processes
- Numerical analysis
- Operations research, mathematical programming
- Statistics
- Calculus of variations and optimal control
- Ordinary differential equations
- Partial differential equations
- Functional analysis
- Approximations and expansions
- Information and communication theory
- (and other MSC 2020 categories as appropriate)

**CS/ML** -- use the narrowest applicable discipline:
- Machine learning
- Deep learning
- Computer vision
- Natural language processing
- Reinforcement learning
- Information theory
- Neural and evolutionary computing
- Pattern recognition
- Optimization
- Signal processing
- Large language models
- Computation and language
- Artificial intelligence
- Robotics
- (and other CS task areas as appropriate)

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--max-depth` | 100 | Max structural depth used when selecting pending nodes and ingest expansion |
| `--limit` | 10-20 | Batch size per iteration (adjust for speed vs. thoroughness) |
| Output path | `knowledge_graph.json` | Default graph file |

## Resumability

The graph file is the checkpoint. If a build is interrupted, simply run `pending` on the existing file to pick up where you left off. New seeds can be added to an existing graph with `add-seeds`.
