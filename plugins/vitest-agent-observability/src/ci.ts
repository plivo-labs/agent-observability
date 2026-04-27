import type { CiMetadata } from "./types.js";

export function detectCi(env: NodeJS.ProcessEnv = process.env): CiMetadata | null {
  if (env.GITHUB_ACTIONS === "true") return github(env);
  if (env.GITLAB_CI === "true") return gitlab(env);
  if (env.CIRCLECI === "true") return circleci(env);
  if (env.BUILDKITE === "true") return buildkite(env);
  return null;
}

function github(env: NodeJS.ProcessEnv): CiMetadata {
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  return clean({
    provider: "github",
    run_url: repo && runId ? `${server}/${repo}/actions/runs/${runId}` : undefined,
    git_sha: env.GITHUB_SHA,
    git_branch: env.GITHUB_REF_NAME || env.GITHUB_REF,
  });
}

function gitlab(env: NodeJS.ProcessEnv): CiMetadata {
  return clean({
    provider: "gitlab",
    run_url: env.CI_JOB_URL,
    git_sha: env.CI_COMMIT_SHA,
    git_branch: env.CI_COMMIT_REF_NAME,
    commit_message: env.CI_COMMIT_MESSAGE,
  });
}

function circleci(env: NodeJS.ProcessEnv): CiMetadata {
  return clean({
    provider: "circleci",
    run_url: env.CIRCLE_BUILD_URL,
    git_sha: env.CIRCLE_SHA1,
    git_branch: env.CIRCLE_BRANCH,
  });
}

function buildkite(env: NodeJS.ProcessEnv): CiMetadata {
  return clean({
    provider: "buildkite",
    run_url: env.BUILDKITE_BUILD_URL,
    git_sha: env.BUILDKITE_COMMIT,
    git_branch: env.BUILDKITE_BRANCH,
    commit_message: env.BUILDKITE_MESSAGE,
  });
}

function clean(d: CiMetadata): CiMetadata {
  const out: CiMetadata = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}
