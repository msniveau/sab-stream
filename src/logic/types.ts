export enum FlowNodeType {
    Unknown = 'unknown',
    Start = 'start',
    Checkpoint = 'checkpoint',
    Split = 'split',
    Converge = 'converge',
    End = 'end',
    Boss = 'boss'
}

export interface RuntimeNode {
    id: string;
    index: number;
    label: string;
    runtimeLabel: string;
    nodeType: FlowNodeType;
    sectionSideRaw: string;
    segmentId: string;
    segmentLabel: string;
    overlayX: number;
    overlayY: number;
    ignoreNode: boolean;
    isBound: boolean;
    isEndOfRace: boolean;
    mapId: number | null;
    worldX: number;
    worldY: number;
    worldZ: number;
    triggerRadius: number;
    triggerAngle: number;
    sectionDisplayName: string;
    sectionSide: string;
    sectionIndex: number;
    segmentIndex: number;
    outgoing: RuntimeEdge[];
    incoming: RuntimeEdge[];
}

export interface RuntimeEdge {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    fromSocketIndex: number;
    toSocketIndex: number;
    toNode?: RuntimeNode;
}

export interface RuntimeGraph {
    layoutName: string;
    version: string;
    exportedAtUtc: string;
    globalTriggerScale: number;
    nodes: RuntimeNode[];
    edges: RuntimeEdge[];
    startNodes: RuntimeNode[];
    finishNodes: RuntimeNode[];
}

export interface BeetleRankUserSnapshot {
    user: string;
    sessionCode: number | string;
    x: number;
    y: number;
    z: number;
    speed: number;
    angle: number;
    option: string;
    lap: number;
    step: number;
    time: number;
    map: any;
    color: string;
    active: boolean;
}

export interface BeetleRankSnapshot {
    type: string;
    users: BeetleRankUserSnapshot[];
}

export interface RacerOverride {
    displayName?: string;
    vdoNinjaId?: string;
}

export interface RacerRuntimeState {
    racerKey: string;
    racerName: string;
    colorHex: string;
    isActive: boolean;
    lastConfirmedNode: RuntimeNode | null;
    currentTargetNode: RuntimeNode | null;
    edgeProgress: number;
    hasFinished: boolean;
    statusText: string;
    lastUpdateUtc: number;
    sessionCode: number | string;
    
    // Internal state for logic
    awaitingBranchDecision: boolean;
    pendingSplitNode: RuntimeNode | null;
    candidateBranchEntryNodes: RuntimeNode[]; // List of candidate entry points for split
    activeBranchRootNode: RuntimeNode | null; // The split node that started the branch
    activeBranchEntryNode: RuntimeNode | null; // The node where the branch was entered
    branchLocked: boolean; // Flag to lock once a branch is chosen
    branchLockReason: string;
    
    totalProgress: number;
    isRemoved?: boolean;
    lastX?: number;
    lastY?: number;
    lastZ?: number;
    confirmedNodes: string[]; // List of confirmed node IDs
    skippedNodes: string[]; // List of skipped node IDs
    nodeProgress: Map<string, number>; // Progress weight for each node ID
    confirmationHistory: string[]; // List of confirmed node IDs (limited to 20)
}
