/**
 * One client for a tsbb board, shared by everything that is not the board.
 *
 * The terminal client, the CLI's remote commands and the MCP server all talk to
 * a board the same way — over the REST API, with a bearer token — so they share
 * this rather than each growing their own half of it. Anything a client can do
 * is something the API already allows, which is what keeps the three surfaces
 * from drifting apart.
 */
export {
  ApiError,
  BoardClient,
  type ApiIndex,
  type BoardStats,
  type ClientOptions,
  type ForumNode,
  type ForumRow,
  type Me,
  type Notification,
  type PostView,
  type Profile,
  type SearchHit,
  type TopicSummary,
} from './client.ts';
export { login, LoginError, type LoginOptions } from './login.ts';
export {
  configPath,
  currentBoard,
  loadConfig,
  normaliseServer,
  rememberBoard,
  saveConfig,
  type BoardConfig,
  type Config,
} from './config.ts';
