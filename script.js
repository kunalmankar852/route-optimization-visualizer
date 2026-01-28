/************************************************************************
 * Detailed commented single-file app:
 * - Leaflet map UI for manual graph creation (add nodes, move, connect)
 * - Graph algorithms: Dijkstra and A* (weights = haversine meters)
 * - Structured logging store (summary + optional detailed entries)
 *
 * Read the inline comments to understand how each part works.
 ************************************************************************/

(function () {
  // Shortcut to get element by id
  const $ = (id) => document.getElementById(id);

  /************************************************************************
   * Initialize the Leaflet map:
   * - setView: initial center and zoom (Lahore example)
   * - add tile layer (OpenStreetMap)
   ************************************************************************/
  const map = L.map("map").setView([31.5204, 74.3587], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  /************************************************************************
   * Graph data structure
   * - nodes: Map<id, {id, lat, lng}>
   * - adj: Map<id, Array<{to, weight}>>
   *
   * Basic operations: addNode, updateNode, addEdge, hasEdge, neighbors
   ************************************************************************/
  class Graph {
    constructor() {
      this.nodes = new Map();
      this.adj = new Map();
    }

    // Add a node with geographic coordinates (lat, lng).
    addNode(id, lat, lng) {
      this.nodes.set(id, { id, lat, lng });
      // Ensure adjacency list exists for this node.
      this.adj.set(id, this.adj.get(id) || []);
    }

    // Update coordinates for a node (e.g., after dragging marker).
    updateNode(id, lat, lng) {
      if (this.nodes.has(id)) {
        this.nodes.get(id).lat = lat;
        this.nodes.get(id).lng = lng;
      }
    }

    // Add undirected edge. Weight defaults to haversine distance (meters).
    addEdge(a, b, weight = null) {
      if (!this.nodes.has(a) || !this.nodes.has(b))
        throw new Error("invalid nodes");
      if (weight === null)
        weight = haversine(this.nodes.get(a), this.nodes.get(b));
      // Add to both adjacency lists (undirected graph).
      this.adj.get(a).push({ to: b, weight });
      this.adj.get(b).push({ to: a, weight });
    }

    // Check if edge exists (used to avoid duplicate edges).
    hasEdge(a, b) {
      return (this.adj.get(a) || []).some((e) => e.to === b);
    }

    // Return neighbors array for a node.
    neighbors(id) {
      return this.adj.get(id) || [];
    }
  }

  /************************************************************************
   * Haversine formula: compute great-circle distance between two coords
   * - Returns distance in meters
   * - Inputs: objects with lat, lng properties
   ************************************************************************/
  function haversine(a, b) {
    const toRad = (v) => (v * Math.PI) / 180;
    const R = 6371000; // Earth radius in meters
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat),
      lat2 = toRad(b.lat);

    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    return R * c;
  }

  /************************************************************************
   * createDivIcon:
   * - Small helper to create a circular, labeled marker icon (HTML/CSS)
   * - Used to give each marker a visible label (e.g., N1 -> shows "1")
   ************************************************************************/
  function createDivIcon(label, bg = "#1e293b", fg = "#fff") {
    // Strip leading 'N' to show numeric label if present:
    const txt = label.replace(/^N/, "");
    const html = `<div style="
        width:28px;height:28px;border-radius:50%;
        background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;
        border:1px solid #0b1220;font-weight:700;font-size:12px;">${txt}</div>`;
    return L.divIcon({
      html,
      className: "",
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  }

  /************************************************************************
   * PriorityQueue (min-heap)
   * - Simple array-based binary heap (sufficient for demos).
   * - push(item, priority) and pop() -> {item, priority}
   * - pop returns the element with smallest priority.
   ************************************************************************/
  class PriorityQueue {
    constructor() {
      this.data = [];
    }
    size() {
      return this.data.length;
    }

    push(item, priority) {
      this.data.push({ item, priority });
      this._bubbleUp();
    }

    pop() {
      if (!this.data.length) return null;
      const top = this.data[0];
      const end = this.data.pop();
      if (this.data.length) {
        this.data[0] = end;
        this._sinkDown();
      }
      return top;
    }

    // Move last element up until heap invariant is satisfied
    _bubbleUp() {
      let n = this.data.length - 1;
      while (n > 0) {
        const p = Math.floor((n - 1) / 2);
        if (this.data[n].priority >= this.data[p].priority) break;
        [this.data[n], this.data[p]] = [this.data[p], this.data[n]];
        n = p;
      }
    }

    // Move root element down to restore heap
    _sinkDown() {
      let idx = 0;
      const len = this.data.length;
      while (true) {
        let left = 2 * idx + 1,
          right = left + 1,
          swap = null;
        if (left < len && this.data[left].priority < this.data[idx].priority)
          swap = left;
        if (
          right < len &&
          (swap === null
            ? this.data[right].priority < this.data[idx].priority
            : this.data[right].priority < this.data[left].priority)
        ) {
          swap = right;
        }
        if (swap === null) break;
        [this.data[idx], this.data[swap]] = [this.data[swap], this.data[idx]];
        idx = swap;
      }
    }
  }

  /************************************************************************
   * Structured logging system:
   * - events array holds structured entries {time, level, text, meta}
   * - pushEvent adds to head (newest first) and re-renders right-side log panel
   * - renderLogs shows 'summary' entries always and 'detail' entries only
   *   when "Detailed logs" checkbox is checked.
   *
   * Purpose: avoid overwhelming user with raw per-calculation dumps; summary
   * lines keep clarity, details available on demand.
   ************************************************************************/
  const events = []; // newest-first
  function pushEvent({ level = "summary", text = "", meta = null }) {
    events.unshift({ time: Date.now(), level, text, meta });
    renderLogs();
    // For developer debugging also output to console
    if (level === "summary") console.log("[SUM]", text);
    else console.debug("[DET]", text, meta);
  }
  function clearEvents() {
    events.length = 0;
    renderLogs();
  }
  function renderLogs() {
    const detailed = $("detailedToggle").checked;
    const html = events
      .map((ev) => {
        if (ev.level === "summary") {
          // Summary entries: short, readable lines
          return `<div class="log-sum">${new Date(ev.time).toLocaleTimeString()} ${ev.text}</div>`;
        }
        if (detailed) {
          // Detail entries contain JSON meta for inspection
          return `<div class="log-det">${new Date(ev.time).toLocaleTimeString()} ${ev.text}<pre>${JSON.stringify(ev.meta, null, 2)}</pre></div>`;
        }
        return "";
      })
      .join("");
    $("logPanel").innerHTML = html;
  }

  /************************************************************************
   * App state:
   * - graph: our logical graph
   * - markerMap: mapping node id -> Leaflet marker (for updating icons, dragging)
   * - nodeCounter: incremental naming N1, N2...
   * - edgeLayers: Leaflet polylines drawn for edges; stored for redraw/removal
   * - selectedForConnect: temporary store when user clicks two markers to connect
   ************************************************************************/
  const graph = new Graph();
  const markerMap = new Map();
  let nodeCounter = 0;
  const edgeLayers = [];
  let selectedForConnect = [];

  /************************************************************************
   * addNode(latlng, givenId)
   * - Adds node to graph and places a draggable marker on the map.
   * - Marker stores its nodeId in marker.options.nodeId for callbacks.
   * - Marker dragend updates graph coordinates and redraws edges.
   * - Marker click supports "connect mode" (user clicks two markers to create edge).
   ************************************************************************/
  function addNode(latlng, givenId = null) {
    // Create a new id if not provided
    nodeCounter++;
    const id = givenId || `N${nodeCounter}`;

    // 1) Add to logical graph
    graph.addNode(id, latlng.lat, latlng.lng);

    // 2) Create a draggable Leaflet marker with a styled div icon
    const marker = L.marker([latlng.lat, latlng.lng], {
      draggable: true,
      icon: createDivIcon(id),
    }).addTo(map);
    marker.options.nodeId = id;

    // Click handler: when connect mode is ON, we record selection and connect after two clicks
    marker.on("click", () => {
      if ($("connectToggle").checked) {
        selectedForConnect.push(id);
        // Visually show selection by changing color
        marker.setIcon(createDivIcon(id, "#06b6d4"));
        if (selectedForConnect.length === 2) {
          connectNodes(selectedForConnect[0], selectedForConnect[1]);
          // Reset icon colors back to default
          for (const nid of selectedForConnect) {
            const m = markerMap.get(nid);
            if (m) m.setIcon(createDivIcon(nid));
          }
          selectedForConnect = [];
        }
      }
    });

    // Dragend handler: update node coordinates in graph and redraw edges
    marker.on("dragend", (ev) => {
      const p = ev.target.getLatLng();
      graph.updateNode(id, p.lat, p.lng);
      redrawEdges();
      renderEdgeList();
      pushEvent({
        level: "summary",
        text: `Node ${id} moved to ${p.lat.toFixed(5)},${p.lng.toFixed(5)}`,
      });
    });

    // Keep marker reference for later updates and UI changes
    markerMap.set(id, marker);

    // Update UI and logs
    populateSelects();
    renderEdgeList();
    pushEvent({
      level: "summary",
      text: `Added node ${id} at ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`,
    });

    return id;
  }

  /************************************************************************
   * connectNodes(a,b)
   * - Adds an undirected edge in the logical graph and draws a polyline.
   * - Edge weight uses haversine distance (meters).
   * - Avoids duplicate edges using graph.hasEdge().
   ************************************************************************/
  function connectNodes(a, b) {
    if (!graph.nodes.has(a) || !graph.nodes.has(b)) return;
    if (graph.hasEdge(a, b)) {
      pushEvent({ level: "detail", text: `Edge ${a}-${b} exists` });
      return;
    }
    graph.addEdge(a, b);
    const A = graph.nodes.get(a),
      B = graph.nodes.get(b);
    const poly = L.polyline(
      [
        [A.lat, A.lng],
        [B.lat, B.lng],
      ],
      { color: "#94a3b8" },
    ).addTo(map);
    edgeLayers.push(poly);
    renderEdgeList();
    pushEvent({
      level: "summary",
      text: `Connected ${a} ↔ ${b}: ${haversine(A, B).toFixed(1)} m`,
    });
  }

  /************************************************************************
   * redrawEdges:
   * - Clears all current edge polylines and redraws from the current graph.
   * - Useful after markers are dragged (coordinates change).
   ************************************************************************/
  function redrawEdges() {
    // Remove existing polylines from map
    for (const l of edgeLayers) map.removeLayer(l);
    edgeLayers.length = 0;

    // Draw each undirected edge once (a < b)
    const seen = new Set();
    for (const [a, arr] of graph.adj.entries()) {
      for (const e of arr) {
        const b = e.to;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = graph.nodes.get(a),
          B = graph.nodes.get(b);
        const poly = L.polyline(
          [
            [A.lat, A.lng],
            [B.lat, B.lng],
          ],
          { color: "#94a3b8" },
        ).addTo(map);
        edgeLayers.push(poly);
      }
    }
  }

  /************************************************************************
   * renderEdgeList:
   * - Show a textual list of edges and their weights (meters) in right panel.
   * - Useful for quick inspection of distances between nodes.
   ************************************************************************/
  function renderEdgeList() {
    const lines = [];
    const seen = new Set();
    for (const [a, arr] of graph.adj.entries()) {
      for (const e of arr) {
        const b = e.to;
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`${a} — ${b}: ${e.weight.toFixed(2)} m`);
      }
    }
    $("edgeList").textContent = lines.join("\n") || "(no edges)";
  }

  /************************************************************************
   * populateSelects:
   * - Fills 'Start' and 'Goal' select elements with current node ids.
   ************************************************************************/
  function populateSelects() {
    const s = $("startSelect"),
      g = $("goalSelect");
    s.innerHTML = "";
    g.innerHTML = "";
    for (const id of graph.nodes.keys()) {
      const o1 = document.createElement("option");
      o1.value = id;
      o1.textContent = id;
      const o2 = document.createElement("option");
      o2.value = id;
      o2.textContent = id;
      s.appendChild(o1);
      g.appendChild(o2);
    }
  }

  /************************************************************************
   * autoConnect(k):
   * - For each node, connects it to its k nearest neighbors (by haversine).
   * - Useful to quickly create a connected graph for testing.
   ************************************************************************/
  function autoConnect(k = 2) {
    const nodes = Array.from(graph.nodes.values());
    for (const a of nodes) {
      // compute distances to others
      const arr = nodes
        .map((n) => ({ id: n.id, d: haversine(a, n) }))
        .filter((x) => x.id !== a.id);
      arr.sort((x, y) => x.d - y.d);
      for (let i = 0; i < Math.min(k, arr.length); i++) {
        if (!graph.hasEdge(a.id, arr[i].id)) connectNodes(a.id, arr[i].id);
      }
    }
    redrawEdges();
    renderEdgeList();
    pushEvent({
      level: "summary",
      text: `Auto-connected nearest ${k} neighbors`,
    });
  }

  /************************************************************************
   * resetAll:
   * - Remove markers, polylines, clear graph and UI selections.
   ************************************************************************/
  function resetAll() {
    for (const m of markerMap.values()) map.removeLayer(m);
    markerMap.clear();
    for (const l of edgeLayers) map.removeLayer(l);
    edgeLayers.length = 0;
    graph.nodes.clear();
    graph.adj.clear();
    nodeCounter = 0;
    selectedForConnect = [];
    clearEvents();
    renderEdgeList();
    populateSelects();
    $("distanceLabel").textContent = "—";
    pushEvent({ level: "summary", text: "Graph reset" });
  }

  /************************************************************************
   * Dijkstra algorithm (iterative, using PriorityQueue)
   * - Logs summary events for pops and updates
   * - Optionally logs detailed neighbor checks when `detailed` is true
   *
   * Returns: { path, visitedOrder, dist, cameFrom }
   ************************************************************************/
  function dijkstra(graphObj, start, goal, detailed = false) {
    // Validate nodes
    if (!graphObj.nodes.has(start) || !graphObj.nodes.has(goal))
      throw new Error("Start or goal missing");

    // Initialize distances and PQ
    const dist = new Map();
    const cameFrom = new Map();
    for (const k of graphObj.nodes.keys()) dist.set(k, Infinity);
    dist.set(start, 0);

    const pq = new PriorityQueue();
    pq.push(start, 0);
    pushEvent({ level: "summary", text: `Dijkstra push ${start} (0)` });

    const settled = new Set();
    const visitedOrder = [];

    // Main loop
    while (pq.size() > 0) {
      const top = pq.pop();
      if (!top) break;
      const u = top.item,
        pr = top.priority;

      // Skip stale entries if node already settled
      if (settled.has(u)) {
        if (detailed) pushEvent({ level: "detail", text: `Pop ${u} (stale)` });
        continue;
      }

      // Mark settled (final shortest distance found)
      settled.add(u);
      visitedOrder.push(u);
      pushEvent({
        level: "summary",
        text: `Pop ${u} dist=${dist.get(u).toFixed(2)}`,
      });

      // Stop early if goal reached
      if (u === goal) {
        pushEvent({ level: "summary", text: `Reached ${goal}` });
        break;
      }

      // Explore neighbors and attempt relaxations
      for (const { to: v, weight } of graphObj.neighbors(u)) {
        const alt = dist.get(u) + weight;
        if (detailed) {
          // Provide breakdown for learning: current dist[u] + edge weight = alt
          pushEvent({
            level: "detail",
            text: `Check ${v} from ${u}`,
            meta: {
              u,
              v,
              weight: weight.toFixed(2),
              alt: alt.toFixed(2),
              cur: isFinite(dist.get(v)) ? dist.get(v).toFixed(2) : "∞",
            },
          });
        }
        // Relaxation: if alt is better, update dist and predecessor
        if (alt < dist.get(v)) {
          dist.set(v, alt);
          cameFrom.set(v, u);
          pq.push(v, alt);
          pushEvent({
            level: "summary",
            text: `Update ${v} via ${u} -> ${alt.toFixed(2)}`,
          });
        }
      }
    }

    // If goal unreachable, return partial results
    if (!cameFrom.has(goal) && start !== goal) {
      pushEvent({ level: "summary", text: `Goal unreachable` });
      return { path: null, visitedOrder, dist };
    }

    // Reconstruct path by walking cameFrom from goal to start
    const path = [];
    let cur = goal;
    while (cur !== undefined) {
      path.push(cur);
      if (cur === start) break;
      cur = cameFrom.get(cur);
    }
    path.reverse();

    // Compute cumulative distance along path for summary
    let cum = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i],
        b = path[i + 1];
      const e = graphObj.neighbors(a).find((x) => x.to === b);
      cum += e ? e.weight : 0;
    }
    pushEvent({
      level: "summary",
      text: `Path: ${path.join(" -> ")} dist=${cum.toFixed(2)} m`,
    });

    return { path, visitedOrder, dist, cameFrom };
  }

  /************************************************************************
   * A* algorithm:
   * - Uses haversine distance as heuristic h(n) (admissible for Euclidean distances)
   * - f = g + h, where g is cost-so-far and h is heuristic estimate
   * - Logs summary & optional details similar to Dijkstra
   *
   * Returns: { path, visitedOrder, gScore, cameFrom }
   ************************************************************************/
  function astar(graphObj, start, goal, detailed = false) {
    if (!graphObj.nodes.has(start) || !graphObj.nodes.has(goal))
      throw new Error("Start or goal missing");

    const heuristic = (a, b) =>
      haversine(graphObj.nodes.get(a), graphObj.nodes.get(b));
    const gScore = new Map(),
      fScore = new Map(),
      cameFrom = new Map();
    for (const k of graphObj.nodes.keys()) {
      gScore.set(k, Infinity);
      fScore.set(k, Infinity);
    }
    gScore.set(start, 0);
    fScore.set(start, heuristic(start, goal));

    const open = new PriorityQueue();
    open.push(start, fScore.get(start));
    pushEvent({
      level: "summary",
      text: `A* push ${start} f=${fScore.get(start).toFixed(2)}`,
    });

    const openSet = new Set([start]);
    const visitedOrder = [];

    while (open.size() > 0) {
      const top = open.pop();
      if (!top) break;
      const current = top.item;
      openSet.delete(current);
      visitedOrder.push(current);

      pushEvent({
        level: "summary",
        text: `Pop ${current} f=${top.priority.toFixed(2)} g=${gScore.get(current).toFixed(2)}`,
      });

      if (current === goal) {
        pushEvent({ level: "summary", text: `Reached ${goal}` });
        break;
      }

      for (const { to: neighbor, weight } of graphObj.neighbors(current)) {
        const tentative = gScore.get(current) + weight;
        const h = heuristic(neighbor, goal);
        const fTent = tentative + h;

        if (detailed) {
          // Log the candidate g and estimated f for insight
          pushEvent({
            level: "detail",
            text: `Check ${neighbor}`,
            meta: {
              current,
              neighbor,
              weight: weight.toFixed(2),
              tentative: tentative.toFixed(2),
              h: h.toFixed(2),
              fTent: fTent.toFixed(2),
            },
          });
        }

        if (tentative < gScore.get(neighbor)) {
          // Better path discovered
          cameFrom.set(neighbor, current);
          gScore.set(neighbor, tentative);
          fScore.set(neighbor, fTent);
          open.push(neighbor, fTent);
          openSet.add(neighbor);
          pushEvent({
            level: "summary",
            text: `Update ${neighbor} via ${current} g=${tentative.toFixed(2)} f=${fTent.toFixed(2)}`,
          });
        }
      }
    }

    if (!cameFrom.has(goal) && start !== goal) {
      pushEvent({ level: "summary", text: "Goal unreachable (A*)" });
      return { path: null, visitedOrder, gScore };
    }

    const path = [];
    let cur = goal;
    while (cur !== undefined) {
      path.push(cur);
      if (cur === start) break;
      cur = cameFrom.get(cur);
    }
    path.reverse();

    let cum = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i],
        b = path[i + 1];
      const e = graphObj.neighbors(a).find((x) => x.to === b);
      cum += e ? e.weight : 0;
    }
    pushEvent({
      level: "summary",
      text: `Path: ${path.join(" -> ")} dist=${cum.toFixed(2)} m`,
    });

    return { path, visitedOrder, gScore, cameFrom };
  }

  /************************************************************************
   * Map interaction: click to add node (when "Add node" checked)
   * - map.on('click') receives a Leaflet MouseEvent with latlng property
   ************************************************************************/
  map.on("click", (e) => {
    // Only add node when user explicitly enabled "Add node" mode
    if ($("addNodeToggle").checked) {
      addNode(e.latlng);
    }
  });

  /************************************************************************
   * UI button wiring & control bindings
   * - Reset, Auto-connect, toggle detailed logs, run algorithms
   ************************************************************************/
  $("btnReset").addEventListener("click", () => resetAll());
  $("autoConnect").addEventListener("click", () => autoConnect(2));
  $("detailedToggle").addEventListener("change", renderLogs);

  // Run Dijkstra: clear logs, validate start/goal, run algorithm and show results
  $("btnDijkstra").addEventListener("click", () => {
    clearEvents();
    const s = $("startSelect").value,
      g = $("goalSelect").value;
    if (!s || !g) {
      pushEvent({ level: "summary", text: "Select start and goal." });
      return;
    }
    const res = dijkstra(graph, s, g, $("detailedToggle").checked);
    if (res && res.path) {
      showPath(res.path);
      $("distanceLabel").textContent = res.path
        ? `${computeDistance(res.path).toFixed(2)} m`
        : "—";
    } else $("distanceLabel").textContent = "No path";
  });

  // Run A*: same pattern as Dijkstra
  $("btnAstar").addEventListener("click", () => {
    clearEvents();
    const s = $("startSelect").value,
      g = $("goalSelect").value;
    if (!s || !g) {
      pushEvent({ level: "summary", text: "Select start and goal." });
      return;
    }
    const res = astar(graph, s, g, $("detailedToggle").checked);
    if (res && res.path) {
      showPath(res.path);
      $("distanceLabel").textContent = res.path
        ? `${computeDistance(res.path).toFixed(2)} m`
        : "—";
    } else $("distanceLabel").textContent = "No path";
  });

  /************************************************************************
   * showPath(path):
   * - Draws a polyline along the node sequence and recolors markers on the path.
   ************************************************************************/
  let pathLayer = null;
  function showPath(path) {
    // remove existing path overlay
    if (pathLayer) map.removeLayer(pathLayer);

    // create latlng array and draw polyline
    const latlngs = path.map((id) => {
      const n = graph.nodes.get(id);
      return [n.lat, n.lng];
    });
    pathLayer = L.polyline(latlngs, { color: "#f97316", weight: 4 }).addTo(map);

    // Recolor markers: path nodes red, others default
    for (const [id, marker] of markerMap.entries()) {
      if (path.includes(id)) marker.setIcon(createDivIcon(id, "#f43f5e"));
      else marker.setIcon(createDivIcon(id, "#1e293b"));
    }
  }

  /************************************************************************
   * computeDistance(path):
   * - Sum edge weights along the path. Useful to display final numeric distance.
   ************************************************************************/
  function computeDistance(path) {
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i],
        b = path[i + 1];
      const edge = graph.neighbors(a).find((x) => x.to === b);
      total += edge ? edge.weight : 0;
    }
    return total;
  }

  /************************************************************************
   * seedExample:
   * - Seeds a small example graph so the app is immediately usable.
   * - Adds nodes A..E and connects a few edges.
   ************************************************************************/
  function seedExample() {
    resetAll();
    addNode({ lat: 31.53, lng: 74.35 }, "A");
    addNode({ lat: 31.52, lng: 74.4 }, "B");
    addNode({ lat: 31.5, lng: 74.38 }, "C");
    addNode({ lat: 31.49, lng: 74.34 }, "D");
    addNode({ lat: 31.51, lng: 74.31 }, "E");
    // Connect edges for a reasonable test graph
    connectNodes("A", "B");
    connectNodes("A", "D");
    connectNodes("B", "C");
    connectNodes("C", "D");
    connectNodes("D", "E");
    connectNodes("B", "E");
    redrawEdges();
    populateSelects();
    renderEdgeList();
    pushEvent({ level: "summary", text: "Example seeded: A,B,C,D,E" });
  }

  // Start with example graph
  seedExample();

  // Expose internals for debugging from console (optional)
  window.ROUTE_DEBUG = {
    graph,
    addNode,
    connectNodes,
    autoConnect,
    dijkstra,
    astar,
    events,
  };
})();
