import { 
    RuntimeGraph, RuntimeNode,
    BeetleRankUserSnapshot, RacerRuntimeState,
    FlowNodeType 
} from './types';

export class RacerProgressResolver {
    private static readonly ReanchorRadiusFactor = 0.5; // Increased for better self-healing
    private static readonly ReanchorRadiusMax = 10.0; // Increased for better self-healing
    private static readonly HysteresisRadiusFactor = 1.2; // Stay inside a bit longer to prevent flickering

    public initializeAtStart(graph: RuntimeGraph, racer: RacerRuntimeState): void {
        const firstStart = graph.nodes.find((n: RuntimeNode) => n.nodeType === FlowNodeType.Start);
        if (!firstStart) {
            console.error("Graph has no start node.");
            return;
        }

        racer.lastConfirmedNode = firstStart;
        const firstEdge = graph.edges.find((e: any) => e.fromNodeId === firstStart.id);
        racer.currentTargetNode = firstEdge ? graph.nodes.find((n: RuntimeNode) => n.id === (firstEdge as any).toNodeId) || null : null;
        racer.edgeProgress = 0;
        racer.totalProgress = 0;
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
    }

    public applyTelemetry(graph: RuntimeGraph, racer: RacerRuntimeState, sample: BeetleRankUserSnapshot): void {
        racer.isActive = sample.active;
        racer.lastUpdateUtc = Date.now();

        // Update basic telemetry fields that should always reflect latest data
        racer.lastX = sample.x;
        racer.lastY = sample.y;
        racer.lastZ = sample.z;

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
        if (reanchorNode) {
            // Only re-anchor if it represents progress (higher index) 
            // OR if the distance to current target is significantly worse than reanchorNode
            const currentIndex = racer.lastConfirmedNode?.index ?? -1;
            
            let shouldReanchor = reanchorNode.index > currentIndex;

            // Self-healing: if we are far from our current path, re-anchor even if index is lower
            if (!shouldReanchor) {
                const distToLast = this.distance3D(sample.x, sample.y, sample.z, racer.lastConfirmedNode.worldX, racer.lastConfirmedNode.worldY, racer.lastConfirmedNode.worldZ);
                const distToTarget = racer.currentTargetNode ? this.distance3D(sample.x, sample.y, sample.z, racer.currentTargetNode.worldX, racer.currentTargetNode.worldY, racer.currentTargetNode.worldZ) : Infinity;
                
                const currentPathDist = Math.min(distToLast, distToTarget);
                const reanchorRadius = this.getReanchorRadius(reanchorNode);
                
                // If we are more than 3x the reanchor radius away from our current path, but inside another trigger, 
                // OR we are at index 0 (initial start) but found a later checkpoint (handled by reanchorNode.index > currentIndex above)
                if (currentPathDist > reanchorRadius * 3) {
                    shouldReanchor = true;
                    console.log(`[Resolver] Self-healing "${racer.racerName}" to ${reanchorNode.label} (Current path distance: ${currentPathDist.toFixed(2)})`);
                }
            }

            if (shouldReanchor) {
                console.log(`[Resolver] Re-anchoring "${racer.racerName}" to ${reanchorNode.label} (ID: ${reanchorNode.id}, Index: ${reanchorNode.index})`);
                this.reanchorToNode(graph, racer, reanchorNode);
                return;
            }
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
            return;
        }

        if (!racer.lastConfirmedNode) {
            racer.totalProgress = 0;
            return;
        }

        // 1. Get all unique segments in order
        const segments: { sectionIndex: number, segmentIndex: number }[] = [];
        graph.nodes.forEach(n => {
            if (!segments.some(s => s.sectionIndex === n.sectionIndex && s.segmentIndex === n.segmentIndex)) {
                segments.push({ sectionIndex: n.sectionIndex, segmentIndex: n.segmentIndex });
            }
        });

        // Sort segments: higher index means further in progress
        // Requirement: W1Z1 < W1Z2 < W1Z3 < W2Z1 < W2Z2 < W2Z3
        segments.sort((a, b) => {
            if (a.sectionIndex !== b.sectionIndex) return a.sectionIndex - b.sectionIndex;
            return a.segmentIndex - b.segmentIndex;
        });

        const totalSegments = segments.length;
        if (totalSegments === 0) {
            racer.totalProgress = 0;
            return;
        }

        // 2. Find current segment index in the flat list
        const currentSegmentFlatIdx = segments.findIndex(s => 
            s.sectionIndex === racer.lastConfirmedNode!.sectionIndex && 
            s.segmentIndex === racer.lastConfirmedNode!.segmentIndex
        );

        if (currentSegmentFlatIdx === -1) {
            racer.totalProgress = 0;
            return;
        }

        // 3. Calculate progress within the current segment
        const currentSegmentNodes = graph.nodes.filter(n => 
            n.sectionIndex === racer.lastConfirmedNode!.sectionIndex && 
            n.segmentIndex === racer.lastConfirmedNode!.segmentIndex
        ).sort((a, b) => a.index - b.index);

        let segmentProgress = 0;
        if (currentSegmentNodes.length > 0) {
            const firstNode = currentSegmentNodes[0];
            const lastNode = currentSegmentNodes[currentSegmentNodes.length - 1];
            
            const startIndex = firstNode.index;
            const endIndex = lastNode.index;
            const totalIndexRange = endIndex - startIndex;

            if (totalIndexRange > 0) {
                const lastIdx = racer.lastConfirmedNode.index;
                const targetIdx = racer.currentTargetNode ? racer.currentTargetNode.index : lastIdx;

                let currentSmoothIndex = lastIdx;
                
                // Check if we are moving within the same segment or to another one
                const isTargetInSameSegment = racer.currentTargetNode && 
                                             racer.currentTargetNode.sectionIndex === racer.lastConfirmedNode.sectionIndex &&
                                             racer.currentTargetNode.segmentIndex === racer.lastConfirmedNode.segmentIndex;

                if (isTargetInSameSegment) {
                    // Standard interpolation within the same segment
                    if (targetIdx > lastIdx) {
                        currentSmoothIndex = lastIdx + (targetIdx - lastIdx) * racer.edgeProgress;
                    }
                } else if (racer.currentTargetNode) {
                    // Moving to a DIFFERENT segment
                    const targetSegmentFlatIdx = segments.findIndex(s => 
                        s.sectionIndex === racer.currentTargetNode!.sectionIndex && 
                        s.segmentIndex === racer.currentTargetNode!.segmentIndex
                    );

                    if (targetSegmentFlatIdx > currentSegmentFlatIdx) {
                        // Moving FORWARD to a next segment: interpolate toward the END of current segment
                        currentSmoothIndex = lastIdx + (endIndex - lastIdx) * racer.edgeProgress;
                    } else if (targetSegmentFlatIdx < currentSegmentFlatIdx && targetSegmentFlatIdx !== -1) {
                        // Moving BACKWARD: interpolate toward the START of current segment (or just stay at lastIdx)
                        currentSmoothIndex = lastIdx - (lastIdx - startIndex) * racer.edgeProgress;
                    }
                }

                segmentProgress = (currentSmoothIndex - startIndex) / totalIndexRange;
            } else {
                // Only one node in segment or all have same index
                segmentProgress = 0.5; 
            }
        }

        // 4. Calculate global progress
        segmentProgress = Math.max(0, Math.min(0.999, segmentProgress)); // Keep within [0, 1) to not jump to next segment
        racer.totalProgress = (currentSegmentFlatIdx + segmentProgress) / totalSegments;
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
            .filter(n => n.nodeType === FlowNodeType.Checkpoint || n.nodeType === FlowNodeType.Start || n.nodeType === FlowNodeType.End || n.nodeType === FlowNodeType.Boss)
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
            racer.hasFinished = true;
            racer.totalProgress = 1.0;
            racer.statusText = "Finished";
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
                    racer.hasFinished = true;
                    racer.statusText = "Finished";
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

            // Favor higher indices if multiple nodes are within range
            if (dist <= reanchorRadius) {
                if (!bestNode || node.index > bestNode.index || (node.index === bestNode.index && dist < bestDistance)) {
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
            racer.hasFinished = true;
            racer.statusText = `Re-anchored to finish node ${node.label}`;
            return;
        }

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

    private canReach(graph: RuntimeGraph, fromNodeId: string, toNodeId: string): boolean {
        const visited = new Set<string>();
        const queue = [fromNodeId];
        visited.add(fromNodeId);

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            if (currentId === toNodeId) return true;

            const outgoing = graph.edges.filter(e => e.fromNodeId === currentId);
            for (const edge of outgoing) {
                if (!visited.has(edge.toNodeId)) {
                    visited.add(edge.toNodeId);
                    queue.push(edge.toNodeId);
                }
            }
        }
        return false;
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
        const totalDist = this.distance3D(from.worldX, from.worldY, from.worldZ, to.worldX, to.worldY, to.worldZ);
        if (totalDist < 0.001) return 0;

        const x = sample.x !== undefined ? sample.x : (racer.lastX ?? 0);
        const y = sample.y !== undefined ? sample.y : (racer.lastY ?? 0);
        const z = sample.z !== undefined ? sample.z : (racer.lastZ ?? 0);

        const distToTarget = this.distance3D(x, y, z, to.worldX, to.worldY, to.worldZ);

        // Progress is 1.0 when at target, and decreases as we move away.
        return 1.0 - (distToTarget / totalDist);
    }

    private getReanchorRadius(node: RuntimeNode): number {
        return Math.min(node.triggerRadius * RacerProgressResolver.ReanchorRadiusFactor, RacerProgressResolver.ReanchorRadiusMax);
    }

    private distance3D(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number {
        return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2) + Math.pow(z2 - z1, 2));
    }
}
