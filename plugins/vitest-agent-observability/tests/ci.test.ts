import { describe, test, expect } from "vitest";
import { detectCi } from "../src/ci.js";

describe("detectCi", () => {
  test("returns null with no CI env", () => {
    expect(detectCi({})).toBeNull();
  });

  test("github", () => {
    const ci = detectCi({
      GITHUB_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "plivo-labs/demo",
      GITHUB_RUN_ID: "42",
      GITHUB_SHA: "abc123",
      GITHUB_REF_NAME: "main",
    } as NodeJS.ProcessEnv);
    expect(ci).not.toBeNull();
    expect(ci!.provider).toBe("github");
    expect(ci!.run_url).toBe("https://github.com/plivo-labs/demo/actions/runs/42");
    expect(ci!.git_sha).toBe("abc123");
    expect(ci!.git_branch).toBe("main");
  });

  test("gitlab", () => {
    const ci = detectCi({
      GITLAB_CI: "true",
      CI_JOB_URL: "https://gitlab/x/jobs/1",
      CI_COMMIT_SHA: "deadbeef",
      CI_COMMIT_REF_NAME: "feature/x",
      CI_COMMIT_MESSAGE: "fix thing",
    } as NodeJS.ProcessEnv);
    expect(ci).not.toBeNull();
    expect(ci!.provider).toBe("gitlab");
    expect(ci!.commit_message).toBe("fix thing");
  });

  test("circleci", () => {
    const ci = detectCi({
      CIRCLECI: "true",
      CIRCLE_BUILD_URL: "https://circleci/jobs/9",
      CIRCLE_SHA1: "cafebabe",
      CIRCLE_BRANCH: "main",
    } as NodeJS.ProcessEnv);
    expect(ci?.provider).toBe("circleci");
    expect(ci?.git_sha).toBe("cafebabe");
  });

  test("empty values are stripped", () => {
    const ci = detectCi({
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "abc",
    } as NodeJS.ProcessEnv);
    expect(ci).not.toBeNull();
    expect(ci!.git_sha).toBe("abc");
    expect(ci!.run_url).toBeUndefined();
  });
});
