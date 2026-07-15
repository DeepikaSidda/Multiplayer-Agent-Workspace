/**
 * Message module: content validation, stamping, ordered logging, and the
 * persist-before-broadcast Message Service.
 */

export {
  MessageService,
  validateMessageContent,
  type MessageRejection,
  type SenderInfo,
  type SenderResolver,
  type SubmitResult,
  type SubmitOptions,
  type MessageServiceOptions,
} from "./MessageService.js";
export { compareMessages, orderMessages } from "./ordering.js";
