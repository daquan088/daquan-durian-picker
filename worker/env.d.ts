export interface Env {
  MODEL_ID: string
  OPENAI_BASE_URL?: string
  ASSETS: Fetcher
  QUOTA_COORDINATOR: DurableObjectNamespace
  OPENAI_API_KEY: string
  QUOTA_SALT: string
  TASK_TOKEN_SECRET: string
}
