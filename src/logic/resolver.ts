import {
    RuntimeGraph, RuntimeNode,
    BeetleRankUserSnapshot, RacerRuntimeState,
    FlowNodeType
} from './types';

export class RacerProgressResolver {
    private static readonly ReanchorRadiusFactor = 0.35; 
    private static readonly ReanchorRadiusMax = 6.0; 
    private static readonly HysteresisRadiusFactor = 1.0; 

    public initializeAtStart(graph: RuntimeGraph, racer: RacerRuntimeState): void {
        const firstStart = graph.nodes.find((n: RuntimeNode) => n.isBound && n.nodeType === FlowNodeType.Start);
        if (!firstStart) {
            console.error("Graph has no bound start node.");
            return;
        }

        racer.lastConfirmedNode = firstStart;
        const firstEdge = graph.edges.find((e: any) => e.fromNodeId === firstStart.id);
        racer.currentTargetNode = firstEdge ? graph.nodes.find((n: RuntimeNode) => n.id === (firstEdge as any).toNodeId) || null : null;
        racer.edgeProgress = 0;
        racer.totalProgress = 0;
        racer.sectionProgress = 0;
        racer.segmentProgress = 0;
        racer.statusText = "Initialized";
        racer.hasFinished = false;
        racer.awaitingBranchDecision = false;
        racer.pendingSplitNode = null;
        racer.candidateBranchEntryNodes = [];
        racer.activeBranchRootNode = null;
        racer.activeBranchEntryNode = null;
        racer.branchLocked = false;
        racer.branchLockReason = "";
        racer.confirmedNodes = [];
        racer.skippedNodes = [];
        racer.confirmationHistory = [];
        racer.nodeProgress = new Map<string, number>();
        
        this.addHistory(racer, firstStart);
        this.updateTotalProgress(graph, racer);
    }

    public applyTelemetry(graph: RuntimeGraph, racer: RacerRuntimeState, sample: BeetleRankUserSnapshot): void {
        racer.isActive = sample.active;
        racer.lastUpdateUtc = Date.now();

        // Update basic telemetry fields that should always reflect latest data
        racer.lastX = sample.x;
        racer.lastY = sample.y;
        racer.lastZ = sample.z;

        const currentMapId = sample.map !== undefined ? (typeof sample.map === 'object' ? sample.map.id : sample.map) : undefined;
        racer.currentMapId = currentMapId;

        if (currentMapId === 935) {
            racer.statusText = "In Hub / Loading";
            return;
        }

        if (!racer.lastConfirmedNode) {
            // Attempt to re-anchor first before initializing at start
            const reanchorNode = this.findBestReanchorNode(graph, sample);
            if (reanchorNode) {
                console.log(`[Resolver] Initializing "${racer.racerName}" via re-anchor to ${reanchorNode.label}`);
                this.reanchorToNode(graph, racer, reanchorNode);
            } else {
                console.log(`[Resolver] Initializing "${racer.racerName}" at start.`);
                this.initializeAtStart(graph, racer);
            }
        }

        if (!racer.lastConfirmedNode) {
            return;
        }

        // Global strict re-anchor pass
        const reanchorNode = this.findBestReanchorNode(graph, sample);
        if (reanchorNode && reanchorNode.id !== racer.lastConfirmedNode.id) {
            console.log(`[Resolver] Re-anchoring "${racer.racerName}" to ${reanchorNode.label} (ID: ${reanchorNode.id}, Index: ${reanchorNode.index})`);
            racer.hasFinished = false; // Reset finished status on re-anchor
            this.reanchorToNode(graph, racer, reanchorNode);
            return;
        }

        // Handle pending split decision
        if (racer.awaitingBranchDecision && racer.pendingSplitNode) {
            this.handlePendingSplitDecision(graph, racer, sample);
            return;
        }

        if (!racer.currentTargetNode) {
            if (!racer.hasFinished) {
                racer.statusText = "No target node";
                console.log(`[Resolver] "${racer.racerName}" has no target node.`);
            }
            return;
        }

        // Normal forward confirmation
        if (this.isInsideTrigger(racer, sample, racer.currentTargetNode)) {
            console.log(`[Resolver] "${racer.racerName}" confirmed node ${racer.currentTargetNode.label}`);
            racer.hasFinished = false; // Reset finished status if we confirm a node
            this.confirmNode(graph, racer, racer.currentTargetNode, `Confirmed ${racer.currentTargetNode.label}`);
            return;
        }

        // Update interpolated progress
        racer.edgeProgress = this.computeEdgeProgress(racer, racer.lastConfirmedNode, racer.currentTargetNode, sample);
        this.updateTotalProgress(graph, racer);
        racer.statusText = `Moving toward ${racer.currentTargetNode.label}`;
    }

    private updateTotalProgress(graph: RuntimeGraph, racer: RacerRuntimeState): void {
        if (racer.hasFinished) {
            racer.totalProgress = 1.0;
            racer.sectionProgress = 1.0;
            racer.segmentProgress = 1.0;
            return;
        }

        if (!racer.lastConfirmedNode) {
            racer.totalProgress = 0;
            racer.sectionProgress = 0;
            racer.segmentProgress = 0;
            return;
        }

        // If awaiting branch decision at a split, don't update progress
        // Keep the last known progress until branch is selected
        if (racer.awaitingBranchDecision) {
            return;
        }

        // 1. Get all unique sections and segments from bound checkpoints
        const segmentMap = new Map<string, { sectionIndex: number, segmentIndex: number }>();
        graph.nodes.forEach(n => {
            if (n.isBound && (n.nodeType === FlowNodeType.Checkpoint || n.nodeType === FlowNodeType.Start || n.nodeType === FlowNodeType.End || n.nodeType === FlowNodeType.Boss)) {
                const key = `${n.sectionIndex}_${n.segmentIndex}`;
                if (!segmentMap.has(key)) {
                    segmentMap.set(key, { sectionIndex: n.sectionIndex, segmentIndex: n.segmentIndex });
                }
            }
        });
        const segments = Array.from(segmentMap.values());

        // Sort segments: higher index means further in progress
        segments.sort((a, b) => {
            if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex;
            return a.segmentIndex - b.segmentIndex;
        });

        const totalSegments = segments.length;
        if (totalSegments === 0) {
            racer.totalProgress = 0;
            racer.sectionProgress = 0;
            racer.segmentProgress = 0;
            return;
        }

        // 2. Find current segment and section indices
        const currentSegmentFlatIdx = segments.findIndex(s =>
            s.sectionIndex === racer.lastConfirmedNode!.sectionIndex &&
            s.segmentIndex === racer.lastConfirmedNode!.segmentIndex
        );

        if (currentSegmentFlatIdx === -1) {
            racer.totalProgress = 0;
            racer.sectionProgress = 0;
            racer.segmentProgress = 0;
            return;
        }

        const currentSectionIndex = racer.lastConfirmedNode!.sectionIndex;
        const segmentsInSection = segments.filter(s => s.sectionIndex === currentSectionIndex);
        const currentSegmentInSectionIdx = segmentsInSection.findIndex(s => s.segmentIndex === racer.lastConfirmedNode!.segmentIndex);

        // 3. Calculate progress within the current segment
        // Get all checkpoints in this segment sorted by their flow order
        // Important: START nodes must come first, then sort by index, then END nodes last
        const currentSegmentNodes = graph.nodes.filter(n =>
            n.sectionIndex === racer.lastConfirmedNode!.sectionIndex &&
            n.segmentIndex === racer.lastConfirmedNode!.segmentIndex &&
            n.isBound &&
            (n.nodeType === FlowNodeType.Checkpoint || n.nodeType === FlowNodeType.Start || n.nodeType === FlowNodeType.End || n.nodeType === FlowNodeType.Boss)
        ).sort((a, b) => {
            // START nodes always come first
            if (a.nodeType === FlowNodeType.Start && b.nodeType !== FlowNodeType.Start) return -1;
            if (b.nodeType === FlowNodeType.Start && a.nodeType !== FlowNodeType.Start) return 1;

            // END/BOSS nodes always come last
            const aIsEnd = a.nodeType === FlowNodeType.End || a.nodeType === FlowNodeType.Boss;
            const bIsEnd = b.nodeType === FlowNodeType.End || b.nodeType === FlowNodeType.Boss;
            if (aIsEnd && !bIsEnd) return 1;
            if (bIsEnd && !aIsEnd) return -1;

            // Otherwise sort by index
            return a.index - b.index;
        });

        let segmentProgress = 0;
        if (currentSegmentNodes.length > 0) {
            // Find position of current checkpoint in the segment
            const currentNodePosInSegment = currentSegmentNodes.findIndex(n => n.id === racer.lastConfirmedNode!.id);

            if (currentNodePosInSegment !== -1) {
                // Progress is based on: (currentPosition + edgeProgress) / (totalCheckpoints - 1)
                // This ensures: first checkpoint (pos 0) = 0%, last checkpoint (pos N-1) = 100%
                const totalCheckpointsMinusOne = Math.max(1, currentSegmentNodes.length - 1);

                // Add interpolated progress to next checkpoint if we have a target
                let smoothPosition = currentNodePosInSegment;
                if (racer.currentTargetNode) {
                    let targetNodePosInSegment = currentSegmentNodes.findIndex(n => n.id === racer.currentTargetNode!.id);

                    // If target is a SPLIT/CONVERGE node (not in our checkpoint list), find the next real checkpoint
                    if (targetNodePosInSegment === -1 && (racer.currentTargetNode.nodeType === FlowNodeType.Split || racer.currentTargetNode.nodeType === FlowNodeType.Converge)) {
                        // Find all checkpoints that come after the current position
                        const nextCheckpoints = currentSegmentNodes.filter((_n, idx) => idx > currentNodePosInSegment);
                        if (nextCheckpoints.length > 0) {
                            // Use the first checkpoint after current position
                            targetNodePosInSegment = currentNodePosInSegment + 1;
                        }
                    }

                    // Only add edge progress if target is in the same segment and ahead of us
                    if (targetNodePosInSegment > currentNodePosInSegment) {
                        // Edge progress represents our position between current and target
                        smoothPosition = currentNodePosInSegment + racer.edgeProgress;
                    }
                }

                segmentProgress = smoothPosition / totalCheckpointsMinusOne;

                // Debug logging for all checkpoints
                console.log(`[Progress Debug] ${racer.racerName}:`, {
                    currentNode: racer.lastConfirmedNode.label,
                    currentNodeType: racer.lastConfirmedNode.nodeType,
                    currentPos: currentNodePosInSegment,
                    targetNode: racer.currentTargetNode?.label,
                    targetPos: racer.currentTargetNode ? currentSegmentNodes.findIndex(n => n.id === racer.currentTargetNode!.id) : 'none',
                    edgeProgress: racer.edgeProgress,
                    smoothPosition,
                    totalCheckpointsMinusOne,
                    segmentProgress: segmentProgress,
                    sectionProgress: (currentSegmentInSectionIdx + segmentProgress) / segmentsInSection.length,
                    totalProgress: (currentSegmentFlatIdx + segmentProgress) / totalSegments,
                    currentSegmentFlatIdx,
                    totalSegments
                });
            }
        }

        segmentProgress = Math.max(0, Math.min(0.9999, segmentProgress));
        racer.segmentProgress = segmentProgress;

        // 4. Calculate section progress
        if (segmentsInSection.length > 0) {
            racer.sectionProgress = (currentSegmentInSectionIdx + segmentProgress) / segmentsInSection.length;
        } else {
            racer.sectionProgress = 0;
        }

        // 5. Calculate global progress
        racer.totalProgress = (currentSegmentFlatIdx + segmentProgress) / totalSegments;

        racer.sectionProgress = Math.max(0, Math.min(1.0, racer.sectionProgress));
        racer.totalProgress = Math.max(0, Math.min(1.0, racer.totalProgress));
    }

    private confirmNode(graph: RuntimeGraph, racer: RacerRuntimeState, confirmedNode: RuntimeNode, statusText: string): void {
        racer.lastConfirmedNode = confirmedNode;
        this.addHistory(racer, confirmedNode);

        if (!racer.confirmedNodes) {
            racer.confirmedNodes = [];
        }
        
        if (!racer.skippedNodes) {
            racer.skippedNodes = [];
        }

        if (!racer.confirmedNodes.includes(confirmedNode.id)) {
            racer.confirmedNodes.push(confirmedNode.id);
        } else {
            // Even if already in confirmedNodes, it might have been marked as skipped previously 
            // but now we actually TRIGGERED it. So remove it from skippedNodes if it was there.
            const skippedIndex = racer.skippedNodes.indexOf(confirmedNode.id);
            if (skippedIndex !== -1) {
                racer.skippedNodes.splice(skippedIndex, 1);
            }
        }

        // Re-evaluate skipped nodes when a node is confirmed
        const checkpoints = graph.nodes
            .filter(n => n.isBound && (n.nodeType === FlowNodeType.Checkpoint || n.nodeType === FlowNodeType.Start || n.nodeType === FlowNodeType.End || n.nodeType === FlowNodeType.Boss))
            .filter(n => {
                // Node is globally before confirmedNode
                if (n.sectionIndex < confirmedNode.sectionIndex) return true;
                if (n.sectionIndex === confirmedNode.sectionIndex && n.segmentIndex < confirmedNode.segmentIndex) return true;
                if (n.sectionIndex === confirmedNode.sectionIndex && n.segmentIndex === confirmedNode.segmentIndex && n.index < confirmedNode.index) return true;
                return false;
            });

        for (const node of checkpoints) {
            // Check if there is a path from this node to the confirmedNode
            // If so, it must have been passed/skipped
            if (this.canReach(graph, node.id, confirmedNode.id)) {
                if (!racer.confirmedNodes.includes(node.id)) {
                    racer.confirmedNodes.push(node.id);
                }
                if (!racer.skippedNodes.includes(node.id)) {
                    racer.skippedNodes.push(node.id);
                }
            }
        }

        if (confirmedNode.nodeType === FlowNodeType.Converge) {
            this.clearBranchLock(racer);
        }

        if (confirmedNode.nodeType === FlowNodeType.Split) {
            this.enterPendingSplit(graph, racer, confirmedNode);
            racer.currentTargetNode = null;
            racer.edgeProgress = 0;
            racer.statusText = `${statusText} - awaiting branch decision`;
            return;
        }

        const outgoing = graph.edges.filter((e: any) => e.fromNodeId === confirmedNode.id);
        if (outgoing.length === 0) {
            racer.currentTargetNode = null;
            racer.edgeProgress = 1.0;
            
            // Only mark as finished if it's explicitly an end node or end of race
            if (confirmedNode.isEndOfRace || 
                confirmedNode.nodeType === FlowNodeType.End || 
                confirmedNode.nodeType === FlowNodeType.Boss) {
                racer.hasFinished = true;
                racer.totalProgress = 1.0;
                racer.sectionProgress = 1.0;
                racer.segmentProgress = 1.0;
                racer.statusText = "Finished";
            } else {
                racer.statusText = `${statusText} - end of segment`;
                this.updateTotalProgress(graph, racer);
            }
            return;
        }

        const nextEdge = outgoing[0];
        racer.currentTargetNode = graph.nodes.find((n: RuntimeNode) => n.id === (nextEdge as any).toNodeId) || null;
        racer.edgeProgress = 0;
        this.updateTotalProgress(graph, racer);
        racer.statusText = statusText;
    }

    private handlePendingSplitDecision(graph: RuntimeGraph, racer: RacerRuntimeState, sample: BeetleRankUserSnapshot): void {
        for (const candidate of racer.candidateBranchEntryNodes) {
            if (this.isInsideTrigger(racer, sample, candidate)) {
                racer.lastConfirmedNode = candidate;
                racer.hasFinished = false; // Reset finished status if we confirm a node
                this.addHistory(racer, candidate);
                
                if (!racer.confirmedNodes.includes(candidate.id)) {
                    racer.confirmedNodes.push(candidate.id);
                }

                // If this candidate was marked as skipped (due to re-anchor/jump), remove it from skipped
                if (racer.skippedNodes) {
                    const skippedIndex = racer.skippedNodes.indexOf(candidate.id);
                    if (skippedIndex !== -1) {
                        racer.skippedNodes.splice(skippedIndex, 1);
                    }
                }

                racer.activeBranchRootNode = racer.pendingSplitNode;
                racer.activeBranchEntryNode = candidate;
                racer.branchLocked = true;
                racer.branchLockReason = `Locked by first child checkpoint ${candidate.label}`;

                this.clearPendingSplit(racer);

                const outgoing = graph.edges.filter((e: any) => e.fromNodeId === candidate.id);
                if (outgoing.length === 0) {
                    racer.currentTargetNode = null;
                    racer.edgeProgress = 1.0;
                    
                    if (candidate.isEndOfRace || 
                        candidate.nodeType === FlowNodeType.End || 
                        candidate.nodeType === FlowNodeType.Boss) {
                        racer.hasFinished = true;
                        racer.statusText = "Finished";
                    } else {
                        racer.statusText = `Branch confirmed at ${candidate.label} - end of segment`;
                        this.updateTotalProgress(graph, racer);
                    }
                    return;
                }

                const nextEdge = outgoing[0];
                racer.currentTargetNode = graph.nodes.find((n: RuntimeNode) => n.id === (nextEdge as any).toNodeId) || null;
                racer.edgeProgress = 0;
                racer.statusText = `Branch confirmed at ${candidate.label}`;
                return;
            }
        }

        racer.statusText = `Awaiting branch decision at ${racer.pendingSplitNode?.label}`;
    }

    private findBestReanchorNode(graph: RuntimeGraph, sample: BeetleRankUserSnapshot): RuntimeNode | null {
        let bestNode: RuntimeNode | null = null;
        let bestDistance = Infinity;

        let sampleMap: number | null = null;
        if (sample.map !== undefined && sample.map !== null) {
            if (typeof sample.map === 'object' && sample.map.id !== undefined) {
                sampleMap = Number(sample.map.id);
            } else {
                sampleMap = Number(sample.map);
            }
        }

        for (const node of graph.nodes) {
            if (!node.isBound) continue;
            
            // Check if it's a checkpoint or start/end
            if (node.nodeType !== FlowNodeType.Checkpoint && 
                node.nodeType !== FlowNodeType.Start && 
                node.nodeType !== FlowNodeType.End &&
                node.nodeType !== FlowNodeType.Boss) {
                continue;
            }

            if (node.mapId !== null && node.mapId !== sampleMap) {
                continue;
            }

            const dist = this.distance3D(sample.x, sample.y, sample.z, node.worldX, node.worldY, node.worldZ);
            const reanchorRadius = this.getReanchorRadius(node);

            if (dist <= reanchorRadius) {
                if (dist < bestDistance) {
                    bestDistance = dist;
                    bestNode = node;
                }
            }
        }

        return bestNode;
    }

    private reanchorToNode(graph: RuntimeGraph, racer: RacerRuntimeState, node: RuntimeNode): void {
        this.clearPendingSplit(racer);

        // Rebuild lock state based on where we landed.
        this.rebuildBranchStateForNode(graph, racer, node);

        racer.lastConfirmedNode = node;
        this.addHistory(racer, node);
        
        if (!racer.confirmedNodes.includes(node.id)) {
            racer.confirmedNodes.push(node.id);
        }

        // If we re-anchored to a node that was previously marked as skipped, unmark it
        if (racer.skippedNodes) {
            const skippedIndex = racer.skippedNodes.indexOf(node.id);
            if (skippedIndex !== -1) {
                racer.skippedNodes.splice(skippedIndex, 1);
            }
        }

        if (node.nodeType === FlowNodeType.Split) {
            this.enterPendingSplit(graph, racer, node);
            racer.currentTargetNode = null;
            racer.edgeProgress = 0;
            racer.statusText = `Re-anchored to split ${node.label} - awaiting branch decision`;
            return;
        }

        const outgoing = graph.edges.filter((e: any) => e.fromNodeId === node.id);
        if (outgoing.length === 0) {
            racer.currentTargetNode = null;
            racer.edgeProgress = 1.0;
            
            if (node.isEndOfRace || 
                node.nodeType === FlowNodeType.End || 
                node.nodeType === FlowNodeType.Boss) {
                racer.hasFinished = true;
                racer.statusText = `Re-anchored to finish node ${node.label}`;
            } else {
                racer.hasFinished = false;
                racer.statusText = `Re-anchored to ${node.label} - end of segment`;
                this.updateTotalProgress(graph, racer);
            }
            return;
        }

        racer.hasFinished = false;
        const nextEdge = outgoing[0];
        racer.currentTargetNode = graph.nodes.find((n: RuntimeNode) => n.id === (nextEdge as any).toNodeId) || null;
        racer.edgeProgress = 0;
        racer.statusText = `Re-anchored to ${node.label}`;
    }

    private rebuildBranchStateForNode(graph: RuntimeGraph, racer: RacerRuntimeState, node: RuntimeNode): void {
        this.clearBranchLock(racer);

        const incomingEdges = node.incoming;
        // If this is a direct child of a split, it is a branch-entry checkpoint.
        if (incomingEdges.length === 1) {
            const edge = incomingEdges[0];
            const fromNode = graph.nodes.find(n => n.id === edge.fromNodeId);
            if (fromNode?.nodeType === FlowNodeType.Split) {
                racer.activeBranchRootNode = fromNode;
                racer.activeBranchEntryNode = node;
                racer.branchLocked = true;
                racer.branchLockReason = `Rebuilt from branch entry node ${node.label}`;
                return;
            }
        }

        // If deeper in a branch, walk backward to find a split ancestor.
        const result = this.findNearestSplitAncestor(graph, node);
        if (result) {
            racer.activeBranchRootNode = result.splitNode;
            racer.activeBranchEntryNode = result.entryNode;
            racer.branchLocked = true;
            racer.branchLockReason = `Rebuilt from descendant node ${node.label}`;
        }
    }

    private findNearestSplitAncestor(graph: RuntimeGraph, node: RuntimeNode): { splitNode: RuntimeNode, entryNode: RuntimeNode } | null {
        const visited = new Set<string>();
        const queue: { node: RuntimeNode, firstDescendant: RuntimeNode | null }[] = [];

        queue.push({ node, firstDescendant: null });

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current.node.id)) continue;
            visited.add(current.node.id);

            for (const edge of current.node.incoming) {
                const parent = graph.nodes.find(n => n.id === edge.fromNodeId);
                if (!parent) continue;

                if (parent.nodeType === FlowNodeType.Split) {
                    return { splitNode: parent, entryNode: current.node };
                }

                queue.push({ node: parent, firstDescendant: current.node });
            }
        }

        return null;
    }

    private enterPendingSplit(graph: RuntimeGraph, racer: RacerRuntimeState, splitNode: RuntimeNode): void {
        this.clearPendingSplit(racer);

        racer.pendingSplitNode = splitNode;
        racer.awaitingBranchDecision = true;

        const outgoingEdges = graph.edges.filter(e => e.fromNodeId === splitNode.id);
        for (const edge of outgoingEdges) {
            const toNode = graph.nodes.find(n => n.id === edge.toNodeId);
            if (toNode) {
                racer.candidateBranchEntryNodes.push(toNode);
            }
        }
    }

    private addHistory(racer: RacerRuntimeState, node: RuntimeNode): void {
        if (!racer.confirmationHistory) {
            racer.confirmationHistory = [];
        }

        if (racer.confirmationHistory.length === 0 || racer.confirmationHistory[racer.confirmationHistory.length - 1] !== node.id) {
            racer.confirmationHistory.push(node.id);
        }

        if (racer.confirmationHistory.length > 20) {
            racer.confirmationHistory.shift();
        }
    }

    private canReach(graph: RuntimeGraph, fromNodeId: string, toNodeId: string): boolean {
        const visited = new Set<string>();
        const queue = [fromNodeId];
        visited.add(fromNodeId);

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            if (currentId === toNodeId) return true;

            const outgoing = graph.edges.filter((e: any) => e.fromNodeId === currentId);
            for (const edge of outgoing) {
                if (!visited.has(edge.toNodeId)) {
                    visited.add(edge.toNodeId);
                    queue.push(edge.toNodeId);
                }
            }
        }
        return false;
    }

    private clearBranchLock(racer: RacerRuntimeState): void {
        racer.activeBranchRootNode = null;
        racer.activeBranchEntryNode = null;
        racer.branchLocked = false;
        racer.branchLockReason = "";
    }

    private clearPendingSplit(racer: RacerRuntimeState): void {
        racer.pendingSplitNode = null;
        racer.awaitingBranchDecision = false;
        racer.candidateBranchEntryNodes = [];
    }

    private isInsideTrigger(racer: RacerRuntimeState, sample: BeetleRankUserSnapshot, node: RuntimeNode): boolean {
        if (!node.isBound) return false;
        
        let sampleMap: number | null = null;
        if (sample.map !== undefined && sample.map !== null) {
            if (typeof sample.map === 'object' && sample.map.id !== undefined) {
                sampleMap = Number(sample.map.id);
            } else {
                sampleMap = Number(sample.map);
            }
        }

        if (node.mapId !== null && node.mapId !== sampleMap) return false;

        const x = sample.x !== undefined ? sample.x : (racer.lastX ?? 0);
        const y = sample.y !== undefined ? sample.y : (racer.lastY ?? 0);
        const z = sample.z !== undefined ? sample.z : (racer.lastZ ?? 0);

        const dist = this.distance3D(x, y, z, node.worldX, node.worldY, node.worldZ);
        
        // Apply hysteresis: if it's the current target, use a slightly larger radius to prevent flickering
        const threshold = node.triggerRadius * RacerProgressResolver.HysteresisRadiusFactor;
        return dist <= threshold;
    }

    private computeEdgeProgress(racer: RacerRuntimeState, from: RuntimeNode, to: RuntimeNode, sample: BeetleRankUserSnapshot): number {
        const x = sample.x !== undefined ? sample.x : (racer.lastX ?? 0);
        const y = sample.y !== undefined ? sample.y : (racer.lastY ?? 0);
        const z = sample.z !== undefined ? sample.z : (racer.lastZ ?? 0);

        // Vector from -> to
        const dx = to.worldX - from.worldX;
        const dy = to.worldY - from.worldY;
        const dz = to.worldZ - from.worldZ;
        const edgeLengthSq = dx * dx + dy * dy + dz * dz;

        if (edgeLengthSq < 0.001) return 0;

        // Vector from -> sample
        const sx = x - from.worldX;
        const sy = y - from.worldY;
        const sz = z - from.worldZ;

        // Dot product to find projection
        const dot = sx * dx + sy * dy + sz * dz;
        let t = dot / edgeLengthSq;

        // Clamp t to [0, 1]
        t = Math.max(0, Math.min(1.0, t));

        return t;
    }

    private getReanchorRadius(node: RuntimeNode): number {
        return Math.min(node.triggerRadius * RacerProgressResolver.ReanchorRadiusFactor, RacerProgressResolver.ReanchorRadiusMax);
    }

    private distance3D(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number {
        return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2) + Math.pow(z2 - z1, 2));
    }
}
