import { SimplifiedFlowmap, SimplifiedCheckpoint } from './flowmap-simplifier';

interface Segment {
  fromId: string;
  toId: string;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  length: number;
  zone: string;
}

interface ZoneInfo {
  name: string;
  segments: Segment[];
  startId: string;
  totalLength: number;
  mapId: number | null;
}

export class PathCalculator {
  private zones: Map<string, ZoneInfo> = new Map();
  private zoneOrder: string[] = ['W1Z1', 'W1Z2', 'W1Z3', 'W2Z1', 'W2Z2', 'W2Z3'];
  private checkpointMap: Map<string, SimplifiedCheckpoint> = new Map();

  constructor(private flowmap: SimplifiedFlowmap) {
    this.buildSegments();
  }

  private buildSegments() {
    // Build each zone separately
    Object.entries(this.flowmap).forEach(([zoneName, zone]) => {
      const zoneSegments: Segment[] = [];
      let zoneStartId = '';

      // Build checkpoint map and find start
      Object.entries(zone.checkpoints).forEach(([checkpointId, checkpoint]) => {
        this.checkpointMap.set(checkpointId, checkpoint);
        if (checkpoint.type === 'start') {
          zoneStartId = checkpointId;
        }
      });

      // Build segments for this zone
      Object.entries(zone.checkpoints).forEach(([fromId, checkpoint]) => {
        checkpoint.next.forEach((toId: string) => {
          const toCheckpoint = zone.checkpoints[toId];
          if (!toCheckpoint) return;

          const from = { x: checkpoint.x, y: checkpoint.y, z: checkpoint.z };
          const to = { x: toCheckpoint.x, y: toCheckpoint.y, z: toCheckpoint.z };
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const dz = to.z - from.z;
          const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

          zoneSegments.push({
            fromId,
            toId,
            from,
            to,
            length,
            zone: zoneName
          });
        });
      });

      // Calculate total length for this zone (longest path from start to any end)
      const zoneTotalLength = this.calculateZoneLength(zoneStartId, zone.checkpoints, zoneSegments);

      this.zones.set(zoneName, {
        name: zoneName,
        segments: zoneSegments,
        startId: zoneStartId,
        totalLength: zoneTotalLength,
        mapId: zone.mapId
      });

      console.log(`PathCalculator: Zone ${zoneName} - ${zoneSegments.length} segments, length ${zoneTotalLength.toFixed(2)}, start: ${zoneStartId}`);
    });

    const totalLength = Array.from(this.zones.values()).reduce((sum, z) => sum + z.totalLength, 0);
    console.log(`PathCalculator: Total path length across all zones: ${totalLength.toFixed(2)} units`);
  }

  private calculateZoneLength(startId: string, checkpoints: { [id: string]: SimplifiedCheckpoint }, segments: Segment[]): number {
    let maxDistance = 0;

    // Find all END checkpoints in this zone
    const endCheckpoints = Object.entries(checkpoints)
      .filter(([_, cp]) => cp.type === 'end' || cp.type === 'boss')
      .map(([id, _]) => id);

    // Calculate longest path to each end
    endCheckpoints.forEach(endId => {
      const distance = this.getDistanceInZone(startId, endId, segments);
      maxDistance = Math.max(maxDistance, distance);
    });

    return maxDistance;
  }

  private getDistanceInZone(fromId: string, toId: string, segments: Segment[]): number {
    if (fromId === toId) return 0;

    // DFS to find longest path
    const visited = new Set<string>();
    let maxDistance = 0;

    const dfs = (currentId: string, currentDistance: number) => {
      if (currentId === toId) {
        maxDistance = Math.max(maxDistance, currentDistance);
        return;
      }

      if (visited.has(currentId)) return;
      visited.add(currentId);

      segments.forEach(segment => {
        if (segment.fromId === currentId) {
          dfs(segment.toId, currentDistance + segment.length);
        }
      });

      visited.delete(currentId);
    };

    dfs(fromId, 0);
    return maxDistance;
  }

  public getProgress(x: number, y: number, z: number): number {
    if (this.zones.size === 0) return 0;

    // Find closest segment across all zones
    let closestSegment: Segment | null = null;
    let closestDistance = Infinity;
    let closestT = 0;
    let closestZone: ZoneInfo | null = null;

    this.zones.forEach(zone => {
      zone.segments.forEach(segment => {
        const { from, to } = segment;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dz = to.z - from.z;

        const px = x - from.x;
        const py = y - from.y;
        const pz = z - from.z;

        const dot = px * dx + py * dy + pz * dz;
        const lenSq = dx * dx + dy * dy + dz * dz;

        let t = 0;
        if (lenSq > 0) {
          t = Math.max(0, Math.min(1, dot / lenSq));
        }

        const closestX = from.x + t * dx;
        const closestY = from.y + t * dy;
        const closestZ = from.z + t * dz;

        const distX = x - closestX;
        const distY = y - closestY;
        const distZ = z - closestZ;
        const distance = Math.sqrt(distX * distX + distY * distY + distZ * distZ);

        if (distance < closestDistance) {
          closestDistance = distance;
          closestSegment = segment;
          closestT = t;
          closestZone = zone;
        }
      });
    });

    if (!closestSegment || !closestZone) return 0;

    // Calculate progress within current zone
    const zone = closestZone as ZoneInfo;
    const segment = closestSegment as Segment;
    const distanceInZone = this.getDistanceInZone(zone.startId, segment.fromId, zone.segments) +
                          (segment.length * closestT);
    const zoneProgress = zone.totalLength > 0 ? distanceInZone / zone.totalLength : 0;

    // Calculate how many zones completed before this one
    const currentZoneIndex = this.zoneOrder.indexOf(zone.name);
    let completedZonesLength = 0;
    for (let i = 0; i < currentZoneIndex; i++) {
      const zone = this.zones.get(this.zoneOrder[i]);
      if (zone) {
        completedZonesLength += zone.totalLength;
      }
    }

    // Total progress = (completed zones + current zone progress) / total length
    const totalLength = Array.from(this.zones.values()).reduce((sum, z) => sum + z.totalLength, 0);
    const totalDistance = completedZonesLength + (zoneProgress * zone.totalLength);
    const overallProgress = totalLength > 0 ? (totalDistance / totalLength) * 100 : 0;

    console.log(`[Progress] Zone: ${zone.name}, zoneProgress: ${(zoneProgress * 100).toFixed(1)}%, overall: ${overallProgress.toFixed(1)}%`);

    return overallProgress;
  }
}
