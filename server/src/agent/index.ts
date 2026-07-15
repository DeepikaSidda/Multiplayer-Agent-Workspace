/**
 * Bedrock Agent Service module — assembles workspace context and invokes Amazon
 * Nova Pro via ConverseStream so agents can respond as teammates (Requirement
 * 5). Helpers are exported for independent testing.
 */

export {
  BedrockAgentServiceImpl,
  buildSystemPrompt,
  mapLogToConverseMessages,
  parseArtifactBlock,
  AGENT_INFERENCE_CONFIG,
  type BedrockAgentService,
  type AgentGenerationInput,
  type AgentGenerationResult,
  type ConverseRole,
  type ConverseMessage,
  type ConverseStreamClient,
  type ParseArtifactResult,
  type GenerateOptions,
} from "./BedrockAgentService.js";
