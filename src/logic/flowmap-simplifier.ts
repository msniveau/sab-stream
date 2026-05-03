export interface SimplifiedCheckpoint {
    x: number;
    y: number;
    z: number;
    next: string[];
    type?: string; // start, checkpoint, end, boss
}

export interface SimplifiedZone {
    mapId: number | null;
    checkpoints: {
        [checkpointId: string]: SimplifiedCheckpoint;
    };
}

export interface SimplifiedFlowmap {
    [zoneLabel: string]: SimplifiedZone;
}

export function simplifyFlowmap(rawFlowmap: any): SimplifiedFlowmap {
    const simplified: SimplifiedFlowmap = {};

    if (!rawFlowmap.sections || !Array.isArray(rawFlowmap.sections)) {
        return simplified;
    }

    // First pass: create zones and checkpoints with positions
    rawFlowmap.sections.forEach((section: any) => {
        if (!section.segments || !Array.isArray(section.segments)) return;

        section.segments.forEach((segment: any) => {
            const zoneLabel = segment.label || `zone_${segment.id}`;

            // Get mapId from first bound node's telemetry
            let mapId: number | null = null;
            if (segment.nodes && Array.isArray(segment.nodes)) {
                for (const node of segment.nodes) {
                    const binding = node.binding || {};
                    if (binding.isBound) {
                        const telemetry = node.telemetry || {};
                        if (telemetry.mapId) {
                            mapId = Number(telemetry.mapId);
                            break;
                        }
                    }
                }
            }

            simplified[zoneLabel] = {
                mapId,
                checkpoints: {}
            };

            if (!segment.nodes || !Array.isArray(segment.nodes)) return;

            segment.nodes.forEach((node: any) => {
                const binding = node.binding || {};
                if (!binding.isBound) return;

                const telemetry = node.telemetry || {};
                const position = telemetry.position || {};

                simplified[zoneLabel].checkpoints[node.id] = {
                    x: position.x || 0,
                    y: position.y || 0,
                    z: position.z || 0,
                    next: [],
                    type: node.type
                };
            });
        });
    });

    // Second pass: populate next[] arrays
    rawFlowmap.sections.forEach((section: any) => {
        if (!section.segments || !Array.isArray(section.segments)) return;

        section.segments.forEach((segment: any) => {
            const zoneLabel = segment.label || `zone_${segment.id}`;
            if (!simplified[zoneLabel]) return;
            if (!segment.nodes || !Array.isArray(segment.nodes)) return;

            segment.nodes.forEach((node: any) => {
                const checkpoint = simplified[zoneLabel].checkpoints[node.id];
                if (!checkpoint) return;

                const graph = node.graph || {};
                const outputs = graph.graphOutputs || [];

                outputs.forEach((output: any) => {
                    if (output.toNodeId) {
                        // Check if target exists in ANY zone
                        let targetExists = false;
                        for (const zone of Object.values(simplified)) {
                            if (zone.checkpoints[output.toNodeId]) {
                                targetExists = true;
                                break;
                            }
                        }
                        if (targetExists) {
                            checkpoint.next.push(output.toNodeId);
                        }
                    }
                });
            });
        });
    });

    return simplified;
}

export function getCheckpointById(flowmap: SimplifiedFlowmap, id: string): SimplifiedCheckpoint | null {
    for (const zone of Object.values(flowmap)) {
        if (zone.checkpoints[id]) {
            return zone.checkpoints[id];
        }
    }
    return null;
}
