if (process.env.GOOGLE_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_API_KEY;
}
if (process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
  process.env.GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

export const CONFIG = {
  targetUrl:      process.env.QA_TARGET_URL      || "http://localhost:3100",
  model:          process.env.QA_MODEL           || "google/gemini-2.5-pro",
  fallbackModel:  process.env.QA_FALLBACK_MODEL  || "google/gemini-2.5-flash",
  plannerModel:   process.env.QA_PLANNER_MODEL   || process.env.QA_FALLBACK_MODEL || "google/gemini-2.5-flash",
  headless:       process.env.QA_HEADLESS !== "false",
  viewportWidth:  parseInt(process.env.QA_VIEWPORT_WIDTH  || "1920", 10),
  viewportHeight: parseInt(process.env.QA_VIEWPORT_HEIGHT || "1080", 10),
  // Set QA_CHROME_PROFILE in .env to reuse a logged-in Chrome session.
  chromeProfile:  process.env.QA_CHROME_PROFILE,
};

export function parseModel(modelStr) {
  const [provider, ...rest] = modelStr.split("/");
  return { provider, model: rest.join("/") };
}

export function getApiKeyForProvider(provider) {
  const envMap = { google: "GOOGLE_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
  return process.env[envMap[provider] || `${provider.toUpperCase()}_API_KEY`];
}
