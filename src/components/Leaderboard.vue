<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, reactive } from 'vue';
import { BeetleRankSnapshot, BeetleRankUserSnapshot, RuntimeGraph, RuntimeNode, RacerRuntimeState, RacerOverride, FlowNodeType } from '../logic/types';
import { parseFlowmap } from '../logic/parser';
import { simplifyFlowmap } from '../logic/flowmap-simplifier';
import { PathCalculator } from '../logic/path-calculator';
import flowmapJson from '../../flowmap.json';

const emit = defineEmits<{
  'switch-view': []
}>();

const racers = ref<Map<string, RacerRuntimeState>>(new Map());
const overrides = ref<Record<string, RacerOverride>>({});
const isManaging = ref(false);
const managingRacerKey = ref<string | null>(null);
const pathRacerKey = ref<string | null>(null);
const fullscreenRacerKey = ref<string | null>(null);
const sessionCode = ref<string | null>(null);
const isShowingPath = ref(false);
const selectedSegmentIndex = ref(0);
const racerIframeReloadKeys = ref<Record<string, number>>({});
const windowSize = reactive({
  width: window.innerWidth,
  height: window.innerHeight
});

const handleResize = () => {
  windowSize.width = window.innerWidth;
  windowSize.height = window.innerHeight;
};
const error = ref<string | null>(null);
const connected = ref(false);
const sessionCodeInput = ref('');
const manualOrder = ref<string[]>([]);

// Load state from localStorage
const loadState = () => {
  const storedOverrides = localStorage.getItem('racerOverrides');
  if (storedOverrides) {
    try {
      overrides.value = JSON.parse(storedOverrides);
    } catch (e) {
      console.error("Failed to parse overrides from localStorage", e);
    }
  }

  const storedSession = localStorage.getItem('sessionCode');
  if (storedSession) {
    sessionCode.value = storedSession;
    sessionCodeInput.value = storedSession;
    
    // Load racers if session exists
    const storedRacers = localStorage.getItem(`racers_${storedSession}`);
    if (storedRacers && graph) {
      try {
        const parsedRacers = JSON.parse(storedRacers);
        for (const [key, racerData] of Object.entries(parsedRacers)) {
          const rd = racerData as any;
          const racer: RacerRuntimeState = {
            ...rd,
            totalProgress: rd.totalProgress,
            sectionProgress: rd.sectionProgress,
            segmentProgress: rd.segmentProgress,
            isManual: rd.isManual || false,
            lastConfirmedNode: rd.lastConfirmedNode ? graph!.nodes.find(n => n.id === rd.lastConfirmedNode.id) || null : null,
            currentTargetNode: rd.currentTargetNode ? graph!.nodes.find(n => n.id === rd.currentTargetNode.id) || null : null,
            pendingSplitNode: rd.pendingSplitNode ? graph!.nodes.find(n => n.id === rd.pendingSplitNode.id) || null : null,
            activeBranchRootNode: rd.activeBranchRootNode ? graph!.nodes.find(n => n.id === rd.activeBranchRootNode.id) || null : null,
            activeBranchEntryNode: rd.activeBranchEntryNode ? graph!.nodes.find(n => n.id === rd.activeBranchEntryNode.id) || null : null,
            candidateBranchEntryNodes: rd.candidateBranchEntryNodes ? rd.candidateBranchEntryNodes.map((n: any) => graph!.nodes.find(gn => gn.id === n.id)).filter((n: any) => !!n) : [],
            confirmationHistory: rd.confirmationHistory || [],
            nodeProgress: new Map<string, number>()
          };
          racers.value.set(key, racer);
        }
      } catch (e) {
        console.error("Failed to parse racers from localStorage", e);
      }
    }
  }
};

// Save state to localStorage
const saveOverrides = () => {
  localStorage.setItem('racerOverrides', JSON.stringify(overrides.value));
};

const saveSession = () => {
  if (sessionCode.value) {
    localStorage.setItem('sessionCode', sessionCode.value);
    saveRacers();
  } else {
    localStorage.removeItem('sessionCode');
  }
};

const saveRacers = () => {
  if (sessionCode.value) {
    try {
      const racersObj = Object.fromEntries(
        Array.from(racers.value.entries()).map(([key, racer]) => {
        // Create a copy and sanitize circular/complex fields
        const sanitizeNode = (node: RuntimeNode | null) => {
          if (!node) return null;
          // Store only the essential fields that aren't circular (no edges)
          return {
            id: node.id,
            index: node.index,
            label: node.label,
            nodeType: node.nodeType,
            sectionIndex: node.sectionIndex,
            segmentIndex: node.segmentIndex,
            worldX: node.worldX,
            worldY: node.worldY,
            worldZ: node.worldZ
          };
        };

        const { 
          nodeProgress, 
          lastConfirmedNode, 
          currentTargetNode,
          pendingSplitNode,
          candidateBranchEntryNodes,
          activeBranchRootNode,
          activeBranchEntryNode,
          confirmationHistory,
          lastX,
          lastY,
          lastZ,
          ...rest 
        } = racer;

        return [key, {
          ...rest,
          lastX,
          lastY,
          lastZ,
          isManual: racer.isManual || false,
          confirmationHistory: confirmationHistory || [],
          lastConfirmedNode: sanitizeNode(lastConfirmedNode),
          currentTargetNode: sanitizeNode(currentTargetNode),
          pendingSplitNode: sanitizeNode(pendingSplitNode),
          candidateBranchEntryNodes: (candidateBranchEntryNodes || []).map(sanitizeNode),
          activeBranchRootNode: sanitizeNode(activeBranchRootNode),
          activeBranchEntryNode: sanitizeNode(activeBranchEntryNode)
        }];
      })
    );
    localStorage.setItem(`racers_${sessionCode.value}`, JSON.stringify(racersObj));
    } catch (e) {
      console.error('[saveRacers] Failed to serialize racersObj:', e);
    }
  }
};

watch(overrides, saveOverrides, { deep: true });
watch(sessionCode, saveSession);
// We'll manually save racers during onmessage to avoid overhead of deep watch on Map

const toggleManagement = (racerKey: string, event: Event) => {
  event.stopPropagation();
  managingRacerKey.value = racerKey;
  isManaging.value = true;
};

const closeManagement = () => {
  isManaging.value = false;
  managingRacerKey.value = null;
};

const togglePath = (racerKey: string, event: Event) => {
  event.stopPropagation();
  pathRacerKey.value = racerKey;
  isShowingPath.value = true;
  
  const racer = racers.value.get(racerKey);
  if (racer && racer.lastConfirmedNode) {
    const sIdx = racer.lastConfirmedNode.sectionIndex;
    const segIdx = racer.lastConfirmedNode.segmentIndex;
    
    // Find matching segment in flat list
    const foundIdx = flatSegmentGroups.value.findIndex(sg => 
      sg.groups && sg.groups.length > 0 &&
      sg.groups[0].nodes && sg.groups[0].nodes.length > 0 &&
      sg.groups[0].nodes[0].sectionIndex === sIdx && 
      sg.groups[0].nodes[0].segmentIndex === segIdx
    );
    
    if (foundIdx !== -1) {
      selectedSegmentIndex.value = foundIdx;
    } else {
      selectedSegmentIndex.value = 0;
    }
  } else {
    selectedSegmentIndex.value = 0;
  }
};

const closePath = () => {
  isShowingPath.value = false;
  pathRacerKey.value = null;
  selectedSegmentIndex.value = 0;
};

const toggleFullscreen = (racerKey: string) => {
  if (fullscreenRacerKey.value === racerKey) {
    fullscreenRacerKey.value = null;
  } else {
    fullscreenRacerKey.value = racerKey;
  }
};


const getDisplayName = (racerKey: string) => {
  return overrides.value[racerKey]?.displayName || racerKey;
};

const reloadStream = (racerKey: string, event: Event) => {
  event.stopPropagation();
  racerIframeReloadKeys.value[racerKey] = (racerIframeReloadKeys.value[racerKey] || 0) + 1;
};

const removeRacer = (racerKey: string, event: Event) => {
  event.stopPropagation();
  const racer = racers.value.get(racerKey);
  if (racer) {
    racer.isRemoved = true;
    saveRacers();
  }
};

const updateOverride = (racerKey: string, field: 'displayName' | 'vdoNinjaId', value: string) => {
  if (!overrides.value[racerKey]) {
    overrides.value[racerKey] = {};
  }
  overrides.value[racerKey][field] = value;
};

let graph: RuntimeGraph | null = null;
let pathCalculator: PathCalculator | null = null;
let socket: WebSocket | null = null;

  const checkpointGroups = computed(() => {
    if (!graph) return [];
    
    const nodes = graph.nodes
      .filter(n => 
        n.nodeType === FlowNodeType.Checkpoint || 
        n.nodeType === FlowNodeType.Start || 
        n.nodeType === FlowNodeType.End || 
        n.nodeType === FlowNodeType.Boss ||
        n.nodeType === FlowNodeType.Split ||
        n.nodeType === FlowNodeType.Converge
      );

    const groups: any[] = [];
    const processedNodeIds = new Set<string>();

    const sortedNodes = [...nodes].sort((a, b) => {
      if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex;
      if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
      return a.index - b.index;
    });

    /**
     * Traverses nodes starting from a split's outputs until they all converge.
     * Returns an array of rows, where each row is an array of nodes appearing at the same "depth"
     */
    const getSplitRows = (splitNode: RuntimeNode): any[][] => {
      const branches: any[][] = [];
      
      splitNode.outgoing.forEach(edge => {
        const branch: any[] = [];
        let current: RuntimeNode | undefined = edge.toNode;
        while (current && current.nodeType !== FlowNodeType.Converge) {
          processedNodeIds.add(current.id);
          if (current.nodeType === FlowNodeType.Split) {
            branch.push(current);
            const nestedRows = getSplitRows(current);
            nestedRows.forEach(row => {
              branch.push({ isRow: true, nodes: row });
            });

            let search: RuntimeNode | undefined = current;
            const visited = new Set<string>();
            while (search && search.nodeType !== FlowNodeType.Converge && !visited.has(search.id)) {
                visited.add(search.id);
                search = search.outgoing[0]?.toNode;
            }
            current = search?.outgoing[0]?.toNode;
          } else {
            branch.push(current);
            current = current.outgoing[0]?.toNode;
          }
        }
        branches.push(branch);
      });

      const rows: any[][] = [];
      const maxLength = Math.max(...branches.map(b => b.length), 0);
      
      for (let i = 0; i < maxLength; i++) {
        const rowNodes: any[] = [];
        branches.forEach(branch => {
          const item = branch[i];
          if (item) {
            if (item.isRow) {
              rowNodes.push(...item.nodes);
            } else {
              rowNodes.push(item);
            }
          } else {
            // Add a placeholder if this branch is shorter to maintain alignment
            rowNodes.push({ id: 'placeholder-' + Math.random(), isPlaceholder: true });
          }
        });
        if (rowNodes.some(n => !n.isPlaceholder)) {
          rows.push(rowNodes);
        }
      }
      return rows;
    };

    for (const node of sortedNodes) {
      if (processedNodeIds.has(node.id)) continue;

      if (node.nodeType === FlowNodeType.Split) {
        processedNodeIds.add(node.id);
        groups.push({
          sectionIndex: node.sectionIndex,
          segmentIndex: node.segmentIndex,
          index: node.index,
          nodes: [node]
        });

        const splitRows = getSplitRows(node);
        for (const rowNodes of splitRows) {
          groups.push({
            sectionIndex: node.sectionIndex,
            segmentIndex: node.segmentIndex,
            index: rowNodes[0].index,
            nodes: rowNodes
          });
        }
      } else {
        processedNodeIds.add(node.id);
        groups.push({
          sectionIndex: node.sectionIndex,
          segmentIndex: node.segmentIndex,
          index: node.index,
          nodes: [node]
        });
      }
    }
    
    return groups;
  });

const sectionGroups = computed(() => {
  if (!graph) return [];
  
  const sections: Record<number, { displayName: string, side: string, segments: Record<number, { label: string, groups: any[] }> }> = {};
  const sectionIndices: number[] = [];

  for (const group of checkpointGroups.value) {
    if (!group || !group.nodes || group.nodes.length === 0) continue;
    
    const firstNode = group.nodes[0];
    const sIdx = firstNode.sectionIndex;
    const segIdx = firstNode.segmentIndex;
    
    if (sIdx === undefined || segIdx === undefined) continue;
    
    if (!sections[sIdx]) {
      sections[sIdx] = {
        displayName: firstNode.sectionDisplayName || `Section ${sIdx}`,
        side: firstNode.sectionSide || 'Right',
        segments: {}
      };
      sectionIndices.push(sIdx);
    }
    
    if (!sections[sIdx].segments[segIdx]) {
      sections[sIdx].segments[segIdx] = {
        label: firstNode.segmentLabel || `Segment ${segIdx}`,
        groups: []
      };
    }
    
    sections[sIdx].segments[segIdx].groups.push(group);
  }

  return sectionIndices.sort((a, b) => a - b).map(sIdx => {
    const section = sections[sIdx];
    const segmentIndices = Object.keys(section.segments).map(Number).sort((a, b) => a - b);
    return {
      ...section,
      segments: segmentIndices.map(segIdx => section.segments[segIdx])
    };
  });
});

const flatSegmentGroups = computed(() => {
  if (!graph) return [];
  
  const result: any[] = [];
  const sections = sectionGroups.value;
  
  sections.forEach((section, sIdx) => {
    if (!section || !section.segments) return;
    section.segments.forEach((segment, segIdx) => {
      if (!segment) return;
      result.push({
        sectionDisplayName: section.displayName,
        sectionSide: section.side,
        sectionIndex: sIdx, // index in sorted sections
        segmentLabel: segment.label,
        segmentIndex: segIdx, // index in sorted segments
        groups: segment.groups || []
      });
    });
  });
  
  return result;
});

const placementSortedRacers = computed(() => {
  const allRacers = Array.from(racers.value.values()).filter(r => !r.isRemoved);
  return allRacers.sort((a, b) => {
    // Manual racers always come last
    if (a.isManual && !b.isManual) return 1;
    if (!a.isManual && b.isManual) return -1;
    if (a.isManual && b.isManual) return a.racerKey.localeCompare(b.racerKey);

    // Finished racers come first
    if (a.hasFinished && !b.hasFinished) return -1;
    if (!a.hasFinished && b.hasFinished) return 1;

    // Sort by total progress (path-based calculation)
    return b.totalProgress - a.totalProgress;
  });
});

const sortedRacers = computed(() => {
  const allRacers = Array.from(racers.value.values()).filter(r => !r.isRemoved);

  if (manualOrder.value.length > 0) {
    // Return racers in the order they were when 'r' was pressed,
    // but handle new racers that might have appeared since then
    const orderMap = new Map(manualOrder.value.map((key, index) => [key, index]));

    return allRacers.sort((a, b) => {
      const indexA = orderMap.has(a.racerKey) ? orderMap.get(a.racerKey)! : 10000;
      const indexB = orderMap.has(b.racerKey) ? orderMap.get(b.racerKey)! : 10000;

      if (indexA !== indexB) return indexA - indexB;

      // Fallback for racers not in manualOrder (e.g. new ones) - keep stable order
      return a.racerKey.localeCompare(b.racerKey);
    });
  }

  // No manual order - keep stable order by racer key (arrival order essentially)
  return allRacers.sort((a, b) => a.racerKey.localeCompare(b.racerKey));
});

const visibleRacers = computed(() => {
  return sortedRacers.value.filter(r => !r.isRemoved);
});

const stableVisibleRacers = computed(() => {
  // We keep a stable order in the DOM to prevent iframe reloads when the visual order changes.
  // We sort by racerKey to ensure the order is consistent regardless of telemetry/manual sort.
  return Array.from(racers.value.values())
    .filter(r => !r.isRemoved)
    .sort((a, b) => a.racerKey.localeCompare(b.racerKey));
});

const racerRanks = computed(() => {
  const ranks: Record<string, number> = {};
  placementSortedRacers.value.forEach((racer, index) => {
    ranks[racer.racerKey] = index + 1;
  });
  return ranks;
});

const racerOrderMap = computed(() => {
  const orderMap: Record<string, number> = {};
  visibleRacers.value.forEach((racer, index) => {
    orderMap[racer.racerKey] = index;
  });
  return orderMap;
});

const gridStyle = computed(() => {
  const count = visibleRacers.value.length;
  if (count === 0) return {};

  // If one racer, take full screen
  if (count === 1) {
    return {
      gridTemplateColumns: '1fr',
      gridTemplateRows: '1fr'
    };
  }

  // Calculate best grid layout (rows x cols) to minimize empty space and fit 16:9 aspect ratio
  // viewport aspect ratio
  const itemAspect = 16 / 9;

  let bestCols = 1;
  let maxItemSize = 0;

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const itemWidth = windowSize.width / cols;
    const itemHeight = itemWidth / itemAspect;

    // If items at this width/height fit in the viewport
    if (itemHeight * rows <= windowSize.height) {
      if (itemWidth > maxItemSize) {
        maxItemSize = itemWidth;
        bestCols = cols;
      }
    } else {
      // Items are too tall, limit by height
      const altItemHeight = windowSize.height / rows;
      const altItemWidth = altItemHeight * itemAspect;
      if (altItemWidth > maxItemSize) {
        maxItemSize = altItemWidth;
        bestCols = cols;
      }
    }
  }

  return {
    gridTemplateColumns: `repeat(${bestCols}, 1fr)`,
    justifyContent: 'center',
    alignContent: 'center',
    width: '100%',
    height: '100%',
    gap: '4px'
  };
});

// Cache for VDO Ninja URLs to prevent re-computing and causing iframe reloads
const vdoNinjaUrlCache = new Map<string, string>();

const getVdoNinjaUrl = (racerKey: string) => {
  const reloadKey = racerIframeReloadKeys.value[racerKey] || 0;
  const overrideId = overrides.value[racerKey]?.vdoNinjaId;
  const cacheKey = `${racerKey}_${overrideId}_${reloadKey}`;
  
  if (vdoNinjaUrlCache.has(cacheKey)) {
    return vdoNinjaUrlCache.get(cacheKey)!;
  }

  let url = '';
  if (overrideId) {
    if (overrideId.startsWith('http')) {
      url = overrideId;
    } else {
      url = `https://vdo.ninja/?view=${overrideId}&autoplay=1&mute=1`;
    }
  } else {
    // Default logic: sanitize racerKey
    const id = racerKey.replace(/\s+/g, '').toLowerCase();
    url = `https://vdo.ninja/?view=${id}&autoplay=1&mute=1`;
  }
  
  if (reloadKey > 0) {
    url += (url.includes('?') ? '&' : '?') + `rk=${reloadKey}`;
  }
  
  vdoNinjaUrlCache.set(cacheKey, url);
  return url;
};

const addManualRacer = () => {
  const name = prompt("Enter racer name/key:");
  if (!name || name.trim() === '') return;
  
  const racerKey = `manual_${Date.now()}_${name.trim().toLowerCase().replace(/\s+/g, '_')}`;
  
  if (racers.value.has(racerKey)) {
    alert("A racer with this key already exists.");
    return;
  }

  const racer = reactive({
    racerKey: racerKey,
    racerName: name.trim(),
    sessionCode: sessionCode.value || "manual",
    colorHex: "#FFFFFF",
    isActive: true,
    isManual: true,
    lastConfirmedNode: null,
    currentTargetNode: null,
    edgeProgress: 0,
    totalProgress: 0,
    sectionProgress: 0,
    segmentProgress: 0,
    hasFinished: false,
    statusText: "Manual Participant",
    lastUpdateUtc: Date.now(),
    awaitingBranchDecision: false,
    pendingSplitNode: null,
    candidateBranchEntryNodes: [],
    activeBranchRootNode: null,
    activeBranchEntryNode: null,
    branchLocked: false,
    branchLockReason: "",
    confirmedNodes: [],
    skippedNodes: [],
    confirmationHistory: [],
    nodeProgress: new Map<string, number>()
  } as RacerRuntimeState);

  racers.value.set(racerKey, racer);
  
  // Set default display name override
  if (!overrides.value[racerKey]) {
    overrides.value[racerKey] = { displayName: name.trim() };
  }
  
  saveRacers();
  
  // Open management for the new racer
  managingRacerKey.value = racerKey;
  isManaging.value = true;
};


const setSession = () => {
  if (sessionCodeInput.value.trim() === '') {
    return;
  }
  const code = Number(sessionCodeInput.value.trim());
  if (isNaN(code)) {
    error.value = "Session code must be numeric";
    return;
  }
  sessionCode.value = String(code);
  localStorage.setItem('sessionCode', sessionCode.value);
  // Clear existing racers and reconnect when session changes
  racers.value.clear();
  localStorage.removeItem(`racers_${sessionCode.value}`);
  connectWebSocket();
};

const connectWebSocket = () => {
  const wsUrl = `wss://www.beetlerank.com:3002`; 
  
  if (socket) {
    socket.close();
  }

  console.log(`Connecting to ${wsUrl} ...`);
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    connected.value = true;
    error.value = null;
    console.log("WebSocket connected");
  };

  socket.onmessage = (event) => {
    try {
        const data: BeetleRankSnapshot = JSON.parse(event.data);
        if (data.type !== "snapshot") return;

        if (data.users && data.users.length > 0) {
            console.log(`[WebSocket] Received snapshot with ${data.users.length} users. Current filter: "${sessionCode.value}"`);
        }

        data.users.forEach((user: BeetleRankUserSnapshot) => {
            if (!user || typeof user !== 'object') return;

            const userSessionCode = user.sessionCode !== undefined ? String(user.sessionCode) : null;
            const targetSession = sessionCode.value;

            if (userSessionCode !== targetSession) {
                return;
            }

            if (!user.user) {
                console.warn('[WebSocket] Received user without user key:', user);
                return;
            }
    
            // If we have a manual order and a NEW racer appears, add them to the end
            if (manualOrder.value.length > 0 && !manualOrder.value.includes(user.user)) {
                manualOrder.value.push(user.user);
            }
    
            let racer = racers.value.get(user.user);
            if (!racer) {
                console.log(`[New Racer] Tracking "${user.user}" (Session: ${userSessionCode})`);
                racer = reactive({
                    racerKey: user.user,
                    racerName: user.user,
                    sessionCode: userSessionCode || "0",
                    colorHex: user.color || "#FFFFFF",
                    isActive: user.active,
                    lastConfirmedNode: null,
                    currentTargetNode: null,
                    edgeProgress: 0,
                    totalProgress: 0,
                    sectionProgress: 0,
                    segmentProgress: 0,
                    hasFinished: false,
                    statusText: "Initializing",
                    lastUpdateUtc: Date.now(),
                    lastX: user.x,
                    lastY: user.y,
                    lastZ: user.z,
                    awaitingBranchDecision: false,
                    pendingSplitNode: null,
                    candidateBranchEntryNodes: [],
                    activeBranchRootNode: null,
                    activeBranchEntryNode: null,
                    branchLocked: false,
                    branchLockReason: "",
                    confirmedNodes: [],
                    skippedNodes: [],
                    confirmationHistory: [],
                    nodeProgress: new Map<string, number>()
                } as RacerRuntimeState);
                racers.value.set(user.user, racer);
            }
            
            if (racer) {
                if (racer.isManual) return; // Skip updating manual racers via telemetry
                
                racer.isActive = user.active;
                racer.lastUpdateUtc = Date.now();
                racer.colorHex = user.color || racer.colorHex;

                // Update position
                racer.lastX = user.x;
                racer.lastY = user.y;
                racer.lastZ = user.z;
                
                const currentMapId = user.map !== undefined ? (typeof user.map === 'object' ? user.map.id : user.map) : undefined;
                racer.currentMapId = currentMapId;

                // Skip progression update if in hub (map 935)
                if (currentMapId === 935) {
                    racer.statusText = "In Hub / Loading";
                    return;
                }

                // Update progress using path calculator (position-based, no checkpoint triggers needed)
                if (pathCalculator && user.x !== undefined && user.y !== undefined && user.z !== undefined) {
                    const progress = pathCalculator.getProgress(user.x, user.y, user.z);
                    racer.totalProgress = progress / 100; // Convert to 0-1 range
                    racer.sectionProgress = progress / 100;
                    racer.segmentProgress = progress / 100;
                    racer.statusText = `${progress.toFixed(1)}% complete`;

                    // Check if finished (>99% progress)
                    if (progress >= 99 && !racer.hasFinished) {
                        racer.hasFinished = true;
                        racer.statusText = "Finished";
                    }
                } else {
                    racer.statusText = "Racing";
                }
            }
        });
        
        // Save racers to local storage periodically or on changes
        saveRacers();
    } catch (e) {
        console.error('[WebSocket] Error processing message:', e);
        console.error('[WebSocket] Raw message that failed:', event.data);
    }
  };

  socket.onclose = () => {
    connected.value = false;
    error.value = "WebSocket connection closed. Retrying...";
    // Only retry if we still have a session code
    if (sessionCode.value) {
      setTimeout(connectWebSocket, 3000);
    }
  };

  socket.onerror = (err) => {
    console.error("WebSocket error", err);
    socket?.close();
  };
};

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key.toLowerCase() === 'r') {
    e.preventDefault();
    // Refresh current order based on progress
    manualOrder.value = placementSortedRacers.value.map(r => r.racerKey);
    console.log("Stream order REFRESHED based on current progress");
  }
};

onMounted(() => {
  // Use capture phase to catch the event even when iframe is focused
  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('resize', handleResize);
  // ... rest of existing onMounted
  const storedSession = localStorage.getItem('sessionCode');
  if (storedSession) {
    if (confirm(`Do you want to change your event ID (currently ${storedSession})?`)) {
      resetSession();
    }
  }

  loadState();
  try {
    graph = parseFlowmap(flowmapJson);
    if (graph) {
      console.log("Flowmap loaded and parsed", graph.layoutName);
    }

    // Generate and log simplified flowmap
    const simplified = simplifyFlowmap(flowmapJson);
    console.log("Simplified Flowmap:", simplified);

    // Initialize path calculator
    pathCalculator = new PathCalculator(simplified);
    console.log("PathCalculator initialized");

    // Save to window for easy access in browser console
    (window as any).simplifiedFlowmap = simplified;
  } catch (e) {
    console.error("Failed to parse flowmap.json", e);
  }
  
  // Connect if session code was loaded from storage
  if (sessionCode.value) {
    connectWebSocket();
  } else {
    // If no session code is set (e.g. wiped), make sure input is empty
    sessionCodeInput.value = '';
  }
});

const resetSession = () => {
  localStorage.removeItem('sessionCode');
  const currentSession = sessionCode.value || localStorage.getItem('sessionCode');
  if (currentSession) {
     localStorage.removeItem(`racers_${currentSession}`);
  }
  sessionCode.value = null;
  sessionCodeInput.value = '';
  if (socket) {
    socket.close();
    socket = null;
  }
  racers.value.clear();
  error.value = null;
  connected.value = false;
};
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown, true);
  window.removeEventListener('resize', handleResize);
  if (socket) {
    socket.close();
  }
});
</script>

<template>
  <div class="leaderboard" :class="{ 'fullscreen-mode': !!fullscreenRacerKey }">
    <div v-if="sessionCode === null" class="session-setup">
      <h2>Enter Event Code</h2>
      <input 
        v-model="sessionCodeInput" 
        type="text" 
        placeholder="Session Code (e.g. 123)"
        @keyup.enter="setSession"
      />
      <button @click="setSession">Start Tracking</button>
    </div>
    
    <template v-else>
      <div v-if="error" class="error">{{ error }}</div>
      
      <!-- Management Modal -->
      <div v-if="isManaging && managingRacerKey" class="modal-overlay" @click="closeManagement">
        <div class="management-modal" @click.stop>
          <div class="modal-header">
            <h3>Manage Racer: {{ managingRacerKey }}</h3>
            <button class="modal-close" @click="closeManagement">×</button>
          </div>
          <div class="management-item">
             <div class="edit-fields">
               <div class="input-group">
                 <label>Display Name</label>
                 <input 
                   type="text" 
                   placeholder="Display Name" 
                   :value="overrides[managingRacerKey]?.displayName" 
                   @input="e => updateOverride(managingRacerKey!, 'displayName', (e.target as HTMLInputElement).value)"
                 />
               </div>
               <div class="input-group">
                 <label>VDO.Ninja ID or URL</label>
                 <input 
                   type="text" 
                   placeholder="VDO.Ninja ID or URL" 
                   :value="overrides[managingRacerKey]?.vdoNinjaId" 
                   @input="e => updateOverride(managingRacerKey!, 'vdoNinjaId', (e.target as HTMLInputElement).value)"
                 />
               </div>
             </div>
          </div>
          <div class="modal-footer">
            <button class="btn-danger" @click="e => { removeRacer(managingRacerKey!, e); closeManagement(); }">Delete Participant</button>
            <button @click="closeManagement">Done</button>
          </div>
        </div>
      </div>

      <!-- Path Modal -->
      <div v-if="isShowingPath && pathRacerKey && racers.get(pathRacerKey)" class="modal-overlay" @click="closePath">
        <div class="management-modal path-modal" @click.stop>
          <div class="modal-header">
            <h3>Race Path: {{ getDisplayName(pathRacerKey) }}</h3>
            <button class="modal-close" @click="closePath">×</button>
          </div>
          <div class="modal-content path-content">
            <div class="section-tabs">
              <button 
                v-for="(sg, idx) in flatSegmentGroups" 
                :key="idx"
                class="tab-btn"
                :class="{ active: selectedSegmentIndex === idx }"
                @click="selectedSegmentIndex = idx"
              >
                <span class="tab-section-name">{{ sg.sectionDisplayName }}</span>
                <span class="tab-segment-label">{{ sg.segmentLabel }}</span>
                <span class="tab-side">{{ sg.sectionSide }}</span>
              </button>
            </div>
            <div v-if="flatSegmentGroups && flatSegmentGroups[selectedSegmentIndex]" class="checkpoint-list">
              <div class="segment-container">
                <div class="segment-header current-segment">
                  <span class="segment-label">{{ flatSegmentGroups[selectedSegmentIndex].sectionDisplayName }} - {{ flatSegmentGroups[selectedSegmentIndex].segmentLabel }}</span>
                </div>
                <div 
                  v-if="flatSegmentGroups[selectedSegmentIndex].groups"
                  v-for="group in flatSegmentGroups[selectedSegmentIndex].groups" 
                  :key="group.index + '-' + (group.nodes ? group.nodes.map((n:any)=>n.id).join('-') : 'empty')"
                  class="checkpoint-group"
                  :class="{ 
                    'split-group': group.nodes && group.nodes.length > 1,
                    'is-split': group.nodes && group.nodes.some((n: any) => n.nodeType === FlowNodeType.Split),
                    'is-converge': group.nodes && group.nodes.some((n: any) => n.nodeType === FlowNodeType.Converge)
                  }"
                >
                  <div 
                    v-if="group.nodes"
                    v-for="node in group.nodes" 
                    :key="node.id"
                    class="checkpoint-item"
                    :class="{ 
                      reached: racers.get(pathRacerKey)?.confirmedNodes?.includes(node.id) && !racers.get(pathRacerKey)?.skippedNodes?.includes(node.id),
                      skipped: racers.get(pathRacerKey)?.skippedNodes?.includes(node.id),
                      current: racers.get(pathRacerKey)?.lastConfirmedNode?.id === node.id,
                      target: racers.get(pathRacerKey)?.currentTargetNode?.id === node.id,
                      'node-split': node.nodeType === FlowNodeType.Split,
                      'node-converge': node.nodeType === FlowNodeType.Converge,
                      'is-placeholder': node.isPlaceholder
                    }"
                  >
                    <template v-if="!node.isPlaceholder">
                      <div class="checkpoint-index">#{{ node.index }}</div>
                      <div class="checkpoint-label">
                        {{ node.label }}
                        <span v-if="node.nodeType === FlowNodeType.Split" class="type-indicator">SPLIT</span>
                        <span v-if="node.nodeType === FlowNodeType.Converge" class="type-indicator">JOIN</span>
                      </div>
                      <div class="checkpoint-status">
                        <span v-if="racers.get(pathRacerKey)?.lastConfirmedNode?.id === node.id" class="status-badge current"></span>
                        <span v-else-if="racers.get(pathRacerKey)?.currentTargetNode?.id === node.id" class="status-badge target"></span>
                        <span v-else-if="racers.get(pathRacerKey)?.skippedNodes?.includes(node.id)" class="status-badge skipped"></span>
                        <span v-else-if="racers.get(pathRacerKey)?.confirmedNodes?.includes(node.id)" class="status-badge reached"></span>
                        <span v-else class="status-badge pending"></span>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button @click="closePath">Close</button>
          </div>
        </div>
      </div>

      <div v-if="!connected && !error" class="connecting">Connecting to telemetry...</div>
      <div v-else class="grid-container" :class="{ 'has-fullscreen': !!fullscreenRacerKey }" :style="gridStyle">
        <div v-for="racer in stableVisibleRacers" :key="racer.racerKey" 
             class="grid-item" 
             :class="{ finished: racer.hasFinished, inactive: !racer.isActive, fullscreen: fullscreenRacerKey === racer.racerKey, hidden: !!fullscreenRacerKey && fullscreenRacerKey !== racer.racerKey }"
             :style="{ order: racerOrderMap[racer.racerKey] }"
             @click="toggleFullscreen(racer.racerKey)">
          <div class="iframe-container">
            <iframe
              :src="getVdoNinjaUrl(racer.racerKey)"
              frameborder="0"
              allow="autoplay; camera; microphone; fullscreen; picture-in-picture; display-capture; midi; encrypted-media; gyroscope; accelerometer"
              style="pointer-events: none;"
            ></iframe>
            <div class="racer-controls" v-if="!fullscreenRacerKey">
              <button class="control-icon remove-icon" title="Remove Racer" @click="removeRacer(racer.racerKey, $event)">
                🗑
              </button>
              <button class="control-icon gear-icon" title="Manage Racer" @click="toggleManagement(racer.racerKey, $event)">
                ⚙
              </button>
              <button class="control-icon path-icon" title="View Path" @click="togglePath(racer.racerKey, $event)">
                🏁
              </button>
              <button class="control-icon expand-icon" title="Expand View" @click.stop="toggleFullscreen(racer.racerKey)">
                ⛶
              </button>
              <button class="control-icon reload-icon" title="Reload Stream" @click="reloadStream(racer.racerKey, $event)">
                ↻
              </button>
            </div>
            <div class="racer-overlay" v-if="!fullscreenRacerKey">
              <div class="racer-info-line">
                <div v-if="!racer.isManual" class="racer-rank">#{{ racerRanks[racer.racerKey] }}</div>
                <div class="racer-name">{{ getDisplayName(racer.racerKey) }}</div>
              </div>
              <div class="racer-details">
                <div class="racer-progress" v-if="!racer.isManual">
                  {{ (racer.totalProgress * 100).toFixed(1) }}%
                </div>
                <div class="racer-progress" v-else>
                  {{ racer.statusText }}
                </div>
              </div>
            </div>
            <div v-if="fullscreenRacerKey === racer.racerKey" class="fullscreen-close">×</div>
          </div>
        </div>
      </div>
      <div v-if="connected && visibleRacers.length === 0 && !fullscreenRacerKey" class="no-data">No racers tracked for this session</div>
      <div v-if="sessionCode && !fullscreenRacerKey" class="hover-menu">
        <button class="menu-btn" @click="addManualRacer" title="Add a racer without telemetry">
          ➕ Add Manual
        </button>
        <button class="menu-btn" @click="handleKeyDown({ key: 'r', preventDefault: () => {} } as KeyboardEvent)" title="Sort streams by progress">
          📊 Sort (R)
        </button>
        <button class="menu-btn" @click="emit('switch-view')" title="Open 3D path viewer">
          🗺️ 3D View (Tab)
        </button>
        <button class="menu-btn btn-ghost" @click="resetSession" title="Change event session">
          🔄 Change Session
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.hover-menu {
  position: fixed;
  bottom: 10px;
  right: 10px;
  z-index: 1000;
  opacity: 0.1;
  transition: opacity 0.3s;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hover-menu:hover {
  opacity: 1;
}

.menu-btn {
  background: rgba(0, 0, 0, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.3);
  color: white;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85em;
  font-weight: 600;
  white-space: nowrap;
  transition: all 0.2s;
}

.menu-btn:hover {
  background: rgba(50, 50, 50, 0.95);
  border-color: rgba(255, 255, 255, 0.5);
  transform: translateX(-2px);
}

.btn-ghost {
  background: rgba(0, 0, 0, 0.5);
  border-color: rgba(255, 255, 255, 0.2);
  color: #aaa;
}

.btn-ghost:hover {
  background: rgba(0, 0, 0, 0.8);
  color: white;
}

.btn-danger {
  background: #c80000;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
}

.btn-danger:hover {
  background: #ff0000;
}

.leaderboard {
  background: black;
  color: white;
  padding: 0;
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  overflow: auto;
}

.leaderboard.fullscreen-mode {
  padding: 0;
  overflow: hidden;
}

.grid-container {
  display: grid;
  gap: 4px;
  padding: 4px;
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
}

.grid-item {
  position: relative;
  background: #000;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.2s, z-index 0.2s;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.grid-item.fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 10000;
  aspect-ratio: unset;
  border: none;
  border-radius: 0;
}

.grid-item.hidden {
  display: none;
}

.fullscreen-close {
  position: absolute;
  top: 20px;
  right: 20px;
  font-size: 40px;
  color: white;
  background: rgba(0, 0, 0, 0.5);
  width: 50px;
  height: 50px;
  line-height: 45px;
  text-align: center;
  border-radius: 50%;
  z-index: 10001;
  opacity: 0;
  transition: opacity 0.3s;
}

.grid-item.fullscreen:hover .fullscreen-close {
  opacity: 1;
}

.grid-item.fullscreen .racer-overlay {
  opacity: 0;
  transition: opacity 0.3s;
}

.grid-item.fullscreen:hover .racer-overlay {
  opacity: 1;
}

.racer-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.3s;
  z-index: 10;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 5px 10px;
}

.racer-info-line {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: center;
  background: linear-gradient(rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.4) 60%, transparent 100%);
  margin: -5px -10px 0 -10px;
  padding: 8px 10px 15px 10px;
}

.racer-rank {
  font-weight: 900;
  color: #ffcc00;
  font-size: 1.2em;
  text-shadow: 0 0 10px rgba(0, 0, 0, 1), 0 0 5px rgba(255, 204, 0, 0.4);
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
}

.racer-name {
  font-weight: 800;
  font-size: 1.2em;
  text-shadow: 0 0 10px rgba(0, 0, 0, 1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #fff;
}

.racer-details {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  background: linear-gradient(transparent 0%, rgba(0, 0, 0, 0.4) 40%, rgba(0, 0, 0, 0.9) 100%);
  margin: 0 -10px -5px -10px;
  padding: 15px 15px 8px 15px;
  width: calc(100% + 20px);
  box-sizing: border-box;
}


.racer-segment-inline {
  font-size: 0.85em;
  color: #ccc;
  font-weight: 600;
  text-shadow: 0 0 8px rgba(0, 0, 0, 1);
}

.racer-progress {
  font-size: 1em;
  color: #eee;
  font-weight: 700;
  text-shadow: 0 0 8px rgba(0, 0, 0, 1);
  text-align: right;
}

.racer-controls {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 100;
  display: flex;
  gap: 5px;
  opacity: 0;
  transition: opacity 0.2s;
}

.grid-item:hover .racer-controls {
  opacity: 1;
}

.control-icon {
  background: rgba(0, 0, 0, 0.5);
  border: none;
  color: white;
  font-size: 1.2em;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s, background 0.2s;
}

.control-icon:hover {
  background: rgba(0, 0, 0, 0.8);
  transform: scale(1.1);
}

.remove-icon:hover {
  background: rgba(200, 0, 0, 0.8);
}

.gear-icon:hover {
  transform: rotate(45deg) scale(1.1);
}

.iframe-container {
  width: 100%;
  height: 100%;
  position: relative;
  aspect-ratio: 16/9;
  max-width: 100%;
  max-height: 100%;
}

.iframe-container iframe {
  width: 100%;
  height: 100%;
  border: none;
}


.rank {
  font-size: 1.5em;
  font-weight: bold;
  text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
}

.name {
  position: absolute;
  top: 10px;
  right: 10px;
  font-size: 1.1em;
  text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
}

.progress {
  align-self: flex-end;
  font-size: 1.2em;
  font-weight: bold;
  text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
}

.inactive {
  opacity: 0.8;
}

.finished {
  border-color: #ffd700;
}

h2 {
  margin-top: 0;
  border-bottom: 2px solid #444;
  padding-bottom: 10px;
  text-align: center;
  font-size: 1.2em;
}

.header {
  position: relative;
  margin-bottom: 15px;
}

.session-info {
  font-size: 0.8em;
  color: #aaa;
  text-align: center;
  margin-top: -5px;
}

.session-setup {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.session-setup input {
  background: #222;
  border: 1px solid #444;
  color: white;
  padding: 8px;
  border-radius: 4px;
}

.session-setup button {
  background: #444;
  color: white;
  border: none;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
}

.session-setup button:hover {
  background: #555;
}

.btn-small {
  background: transparent;
  border: 1px solid #444;
  color: #aaa;
  font-size: 0.8em;
  padding: 2px 5px;
  border-radius: 3px;
  cursor: pointer;
  margin-left: 5px;
}

.btn-small:hover {
  background: #333;
  color: white;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20000;
}

.path-modal {
  width: 98%;
  max-width: 1800px !important;
  max-height: 95vh;
  overflow-y: auto;
  background: #111;
  border: 1px solid #444;
  box-shadow: 0 0 30px rgba(0,0,0,0.8);
}

.section-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  border-bottom: 2px solid #222;
  padding-bottom: 12px;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: #444 transparent;
}

.tab-btn {
  background: #1a1a1a;
  border: 1px solid #333;
  color: #888;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  display: flex;
  flex-direction: column;
  align-items: center;
  transition: all 0.2s ease;
  min-width: 100px;
}

.tab-btn:hover {
  background: #252525;
  border-color: #555;
  color: #ddd;
}

.tab-btn.active {
  background: #333;
  color: #ffcc00;
  border-color: #ffcc00;
  box-shadow: 0 0 10px rgba(255, 204, 0, 0.2);
}

.tab-section-name {
  font-weight: bold;
  font-size: 0.85em;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tab-segment-label {
  font-size: 0.8em;
  margin-top: 2px;
}

.tab-side {
  font-size: 0.65em;
  opacity: 0.5;
  text-transform: uppercase;
  margin-top: 2px;
}

.management-modal {
  background: #111;
  padding: 24px;
  border-radius: 16px;
  width: 90%;
  max-width: 500px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 20px 50px rgba(0,0,0,0.9);
  border: 1px solid #333;
  color: #eee;
}


.path-content {
  margin: 15px 0;
}

.checkpoint-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 10px;
}

.segment-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.segment-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: linear-gradient(90deg, #222, #111);
  border-radius: 6px;
  font-size: 0.85em;
  font-weight: bold;
  color: #bbb;
  border-left: 4px solid #666;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.segment-header.current-segment {
  border-left-color: #2196F3;
  background: linear-gradient(90deg, rgba(33, 150, 243, 0.2), #111);
  color: #fff;
}

.checkpoint-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.checkpoint-group.split-group {
  flex-direction: row;
  background: rgba(255, 255, 255, 0.03);
  padding: 8px 4px 4px 4px;
  border-radius: 8px;
  position: relative;
  margin: 8px 0;
  border: 1px dashed rgba(255, 255, 255, 0.1);
}

.checkpoint-group.is-split::before {
  content: "Split Point";
  position: absolute;
  top: -12px;
  left: 10px;
  font-size: 0.6em;
  color: #aaa;
  text-transform: uppercase;
}

.checkpoint-group.is-converge::after {
  content: "Converge Point";
  position: absolute;
  bottom: -12px;
  left: 10px;
  font-size: 0.6em;
  color: #aaa;
  text-transform: uppercase;
}

.checkpoint-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: #1a1a1a;
  border-radius: 6px;
  gap: 12px;
  border-left: 4px solid #333;
  flex: 1;
  transition: background-color 0.2s ease;
}

.checkpoint-item:hover {
  background: #222;
}

.checkpoint-item.is-placeholder {
  visibility: hidden;
  border: none;
  background: transparent;
}

.type-indicator {
  font-size: 0.6em;
  background: #333;
  color: #888;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 8px;
  vertical-align: middle;
  font-weight: bold;
  border: 1px solid #444;
}

.checkpoint-item.reached {
  border-left-color: #4CAF50;
  background: rgba(76, 175, 80, 0.08);
}

.checkpoint-item.reached:hover {
  background: rgba(76, 175, 80, 0.12);
}

.checkpoint-item.skipped {
  border-left-color: #f44336;
  background: rgba(244, 67, 54, 0.08);
}

.checkpoint-item.skipped:hover {
  background: rgba(244, 67, 54, 0.12);
}

.checkpoint-item.current {
  border-left-color: #2196F3;
  background: rgba(33, 150, 243, 0.12);
  box-shadow: inset 0 0 10px rgba(33, 150, 243, 0.1);
}

.checkpoint-item.current:hover {
  background: rgba(33, 150, 243, 0.18);
}

.checkpoint-item.target {
  border-left-color: #FF9800;
  background: rgba(255, 152, 0, 0.08);
}

.checkpoint-item.target:hover {
  background: rgba(255, 152, 0, 0.12);
}

.checkpoint-index {
  font-weight: bold;
  color: #555;
  min-width: 40px;
  font-family: monospace;
  font-size: 1.1em;
}

.checkpoint-label {
  flex-grow: 1;
  font-weight: 500;
  color: #ccc;
}

.checkpoint-item.current .checkpoint-label {
  color: #fff;
}

.status-badge {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  margin-left: 5px;
}

.status-badge.reached { background: #4CAF50; color: white; }
.status-badge.skipped { background: #f44336; color: white; }
.status-badge.current { background: #2196F3; color: white; }
.status-badge.target { background: #FF9800; color: white; }
.status-badge.pending { background: #444; color: #888; }

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  border-bottom: 1px solid #333;
  padding-bottom: 10px;
}

.modal-header h3 {
  margin: 0;
  font-size: 1.2em;
}

.modal-close {
  background: transparent;
  border: none;
  color: #888;
  font-size: 2em;
  cursor: pointer;
  line-height: 1;
}

.modal-close:hover {
  color: white;
}

.management-item {
  margin-bottom: 20px;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 15px;
}

.input-group label {
  font-size: 0.8em;
  color: #888;
  font-weight: bold;
}

.input-group input {
  background: #2a2a2a;
  border: 1px solid #444;
  color: white;
  padding: 10px;
  border-radius: 6px;
  font-size: 1em;
}

.input-group input:focus {
  border-color: #666;
  outline: none;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
}

.modal-footer button {
  background: #444;
  color: white;
  border: none;
  padding: 8px 20px;
  border-radius: 4px;
  cursor: pointer;
}

.modal-footer button:hover {
  background: #555;
}

ul {
  list-style: none;
  padding: 0;
}

li {
  display: flex;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid #333;
}

li.finished {
    background: rgba(0, 255, 0, 0.1);
}

li.inactive {
    opacity: 0.5;
}

.rank {
  font-weight: bold;
  width: 30px;
}

.color-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin-right: 10px;
  border: 1px solid #fff;
}

.name {
  flex-grow: 1;
  font-weight: 500;
}

.status {
  font-size: 0.75em;
  color: #aaa;
  max-width: 150px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error {
  color: #ff4444;
  text-align: center;
  font-size: 0.9em;
}

.connecting {
    text-align: center;
    color: #aaa;
    font-style: italic;
}

.no-data {
  text-align: center;
  color: #888;
  padding: 20px 0;
}

</style>
