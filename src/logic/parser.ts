import { RuntimeGraph, RuntimeNode, RuntimeEdge, FlowNodeType } from './types';

export function parseFlowmap(json: any): RuntimeGraph {
    const nodes: RuntimeNode[] = [];
    const edges: RuntimeEdge[] = [];
    const nodeMap = new Map<string, RuntimeNode>();
    const startNodes: RuntimeNode[] = [];
    const finishNodes: RuntimeNode[] = [];

    const globalTriggerScale = json.admin?.globalTriggerScale ?? 1.0;

    if (json.sections) {
        json.sections.forEach((section: any, sectionIdx: number) => {
            if (section.segments) {
                section.segments.forEach((segment: any, segmentIdx: number) => {
                    if (segment.nodes) {
                        segment.nodes.forEach((n: any) => {
                            const node: RuntimeNode = {
                                id: n.id,
                                index: n.index,
                                label: n.label,
                                runtimeLabel: n.runtimeLabel,
                                nodeType: parseNodeType(n.type),
                                sectionSideRaw: section.side,
                                segmentId: segment.id,
                                segmentLabel: segment.label,
                                overlayX: n.planner?.x ?? 0,
                                overlayY: n.planner?.y ?? 0,
                                ignoreNode: n.binding?.ignoreNode ?? false,
                                isBound: n.binding?.isBound ?? false,
                                isEndOfRace: n.binding?.isEndOfRace ?? false,
                                mapId: n.telemetry?.mapId ? parseInt(n.telemetry.mapId) : null,
                                worldX: n.telemetry?.position?.x ?? 0,
                                worldY: n.telemetry?.position?.y ?? 0,
                                worldZ: n.telemetry?.position?.z ?? 0,
                                triggerRadius: (n.telemetry?.trigger?.radius ?? 0) * globalTriggerScale,
                                triggerAngle: n.telemetry?.trigger?.angle ?? 0,
                                sectionDisplayName: section.displayName || "Untitled Section",
                                sectionSide: section.side,
                                sectionIndex: sectionIdx,
                                segmentIndex: segmentIdx,
                                outgoing: [],
                                incoming: []
                            };

                            nodes.push(node);
                            nodeMap.set(node.id, node);

                            if (node.nodeType === FlowNodeType.Start) {
                                startNodes.push(node);
                            }

                            if (node.nodeType === FlowNodeType.End || node.nodeType === FlowNodeType.Boss || node.isEndOfRace) {
                                finishNodes.push(node);
                            }
                        });
                    }
                });
            }
        });
    }

    // Second pass to create edges
    if (json.sections) {
        json.sections.forEach((section: any) => {
            if (section.segments) {
                section.segments.forEach((segment: any) => {
                    if (segment.nodes) {
                        segment.nodes.forEach((n: any) => {
                            const fromNode = nodeMap.get(n.id);
                            if (fromNode && n.graph && n.graph.graphOutputs) {
                                n.graph.graphOutputs.forEach((output: any) => {
                                    const toNode = nodeMap.get(output.toNodeId);
                                    if (toNode) {
                                        const edge: RuntimeEdge = {
                                            id: `e_${n.id}_${output.toNodeId}`,
                                            fromNodeId: n.id,
                                            toNodeId: output.toNodeId,
                                            fromSocketIndex: output.fromSocketIndex,
                                            toSocketIndex: output.toSocketIndex,
                                            toNode: toNode
                                        };
                                        edges.push(edge);
                                        fromNode.outgoing.push(edge);
                                        // C# implementation also adds to toNode.Incoming, adding it here for completeness
                                        // (though not strictly in types.ts yet, I added it in types.ts in previous step)
                                        toNode.incoming.push(edge);
                                    }
                                });
                            }
                        });
                    }
                });
            }
        });
    }

    return {
        layoutName: json.layoutName,
        version: json.version,
        exportedAtUtc: json.exportedAtUtc,
        globalTriggerScale,
        nodes,
        edges,
        startNodes,
        finishNodes
    };
}

function parseNodeType(rawType: string | null): FlowNodeType {
    if (!rawType) return FlowNodeType.Unknown;
    const type = rawType.trim().toLowerCase();
    switch (type) {
        case 'start': return FlowNodeType.Start;
        case 'checkpoint': return FlowNodeType.Checkpoint;
        case 'split': return FlowNodeType.Split;
        case 'converge': return FlowNodeType.Converge;
        case 'end': return FlowNodeType.End;
        case 'boss': return FlowNodeType.Boss;
        default: return FlowNodeType.Unknown;
    }
}
