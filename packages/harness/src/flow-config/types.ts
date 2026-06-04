export interface FlowStageRef {
  id: string;
  stage: string;
  agents: string[];
  dependsOn: string[];
}

export interface StageDefinition {
  id: string;
  name: string;
  agents: string[];
  body: string;
  exitCriteria?: string;
}

export interface FlowAgentDefinition {
  id: string;
  name: string;
  model?: string;
  adapter?: string;
  skills?: string[];
  rules?: string[];
  mcp?: string[];
  systemPrompt: string;
}

export interface FlowDefinition {
  id: string;
  name: string;
  filePath: string;
  workspaceRel: string;
  maxRetries: number;
  maxParallel: number;
  goal: string;
  rawBody: string;
  stages: FlowStageRef[];
  stageDefinitions: Map<string, StageDefinition>;
  agents: FlowAgentDefinition[];
}
