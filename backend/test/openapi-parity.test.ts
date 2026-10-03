/**
 * Contract parity: the served routes and the published OpenAPI document must agree.
 *
 * The document is what the Android client and any other consumer is written against,
 * so a route that exists only in code is an undocumented API, and a documented path
 * with no route is a lie.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { startTestApp } from "./helpers.ts";
import { FakeFetch } from "./fakes.ts";

const SPEC_URL = new URL("../../shared/openapi.json", import.meta.url);

interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, { parameters?: unknown[]; responses?: Record<string, unknown> }>>;
}

async function loadSpec(): Promise<OpenApiDocument> {
  return JSON.parse(await readFile(fileURLToPath(SPEC_URL), "utf8")) as OpenApiDocument;
}

/** The routes the server actually serves, e.g. `GET /v1/github/repos/{owner}/{repo}`. */
async function servedRoutes(): Promise<string[]> {
  const app = await startTestApp({ fetchImpl: new FakeFetch().fetch });
  try {
    // Booting the real app guarantees this is the served surface rather than a
    // hand-maintained copy that can drift from the code.
    return [...app.app.router.routeSignatures()].sort();
  } finally {
    await app.close();
    await app.cleanup();
  }
}

function documentedRoutes(spec: OpenApiDocument): string[] {
  const signatures: string[] = [];
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) {
        signatures.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return signatures.sort();
}

test("every served route is documented in the OpenAPI contract", async () => {
  const spec = await loadSpec();
  const served = await servedRoutes();
  const documented = new Set(documentedRoutes(spec));
  const undocumented = served.filter((signature) => !documented.has(signature));
  assert.deepEqual(undocumented, [], "these routes are served but absent from shared/openapi.json");
});

test("the OpenAPI contract documents no route the server does not serve", async () => {
  const spec = await loadSpec();
  const served = new Set(await servedRoutes());
  const phantom = documentedRoutes(spec).filter((signature) => !served.has(signature));
  assert.deepEqual(phantom, [], "shared/openapi.json documents endpoints that do not exist");
});

test("the booted router reports the routes it serves", async () => {
  // Guards the parity tests above: an empty list would make them pass vacuously.
  const served = await servedRoutes();
  assert.ok(served.length >= 30, `expected the full API surface, saw ${served.length} routes`);
  assert.ok(served.includes("GET /v1/github/status"));
  assert.ok(served.includes("POST /v1/github/agent/run"));
});

test("every documented path parameter is declared on the operation", async () => {
  const spec = await loadSpec();
  for (const [path, operations] of Object.entries(spec.paths)) {
    const template = new Set<string>([...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? ""));
    for (const [method, operation] of Object.entries(operations)) {
      const parameters = (operation.parameters ?? []) as { name?: string; in?: string }[];
      const declaredPath = new Set(
        parameters.filter((parameter) => parameter.in === "path").map((parameter) => parameter.name ?? ""),
      );
      for (const name of template) {
        assert.ok(declaredPath.has(name), `${method.toUpperCase()} ${path} does not declare path parameter {${name}}`);
      }
      for (const name of declaredPath) {
        assert.ok(
          template.has(name),
          `${method.toUpperCase()} ${path} declares path parameter ${name}, which the path does not contain`,
        );
      }
    }
  }
});

test("every documented operation declares at least one success response", async () => {
  const spec = await loadSpec();
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const responses = Object.keys(operation.responses ?? {});
      assert.ok(responses.length > 0, `${method.toUpperCase()} ${path} declares no responses`);
      assert.ok(
        responses.some((status) => /^2\d\d$/.test(status)),
        `${method.toUpperCase()} ${path} documents no 2xx response, only ${responses.join(", ")}`,
      );
    }
  }
});

test("the contract declares the security scheme the API actually enforces", async () => {
  const spec = await loadSpec() as OpenApiDocument & {
    security?: unknown;
    components?: { securitySchemes?: Record<string, unknown> };
  };
  assert.ok(spec.components?.securitySchemes?.bearerAuth, "the contract must describe bearer authentication");
  // A root requirement covers every operation; public routes then opt out explicitly
  // so a reader never has to guess which endpoints need a token.
  assert.deepEqual(spec.security, [{ bearerAuth: [] }], "the contract must require a bearer token by default");

  const app = await startTestApp({ fetchImpl: new FakeFetch().fetch });
  const publicRoutes = new Set(app.app.router.publicRouteSignatures());
  await app.close();
  await app.cleanup();

  assert.deepEqual(
    [...publicRoutes].sort(),
    [
      "GET /health",
      "POST /v1/auth/login",
      "POST /v1/auth/logout",
      "POST /v1/auth/refresh",
      "POST /v1/auth/register",
    ],
    "the public surface changed; re-check the contract",
  );

  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const security = (operation as { security?: unknown }).security;
      if (security === undefined) continue;
      assert.deepEqual(
        security,
        [],
        `${method.toUpperCase()} ${path} is authenticated but opts out of the default security`,
      );
    }
  }
});
