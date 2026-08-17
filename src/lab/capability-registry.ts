import type { JsonObject, JsonValue } from "../core/types.js";
import { canonicalJson } from "./canonical.js";
import type {
  CapabilityPlanStep,
  CapabilityState,
  PrimitiveActionType,
  ResourceVector,
} from "./types.js";

const MAX_PLAN_STEPS = 16;
const MAX_INTERFACE_FIELDS = 16;
const MAX_TEST_VECTORS = 16;
const MAX_CONCAT_LENGTH = 16_384;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const RESOURCE_KINDS = [
  "credits", "llmTokens", "computeMs", "storageBytes", "bandwidthBytes",
] as const;

export interface CapabilityPublication {
  id: string;
  inputs: string[];
  outputs: string[];
  primitivePlan: PrimitiveActionType[];
  executionPlan: CapabilityPlanStep[];
  tests: unknown[];
  cost: ResourceVector;
}

/**
 * Capabilities use a deliberately small JSON transformation DSL. There is no
 * source-code field, dynamic dispatch, I/O, or recursion, and every plan has a
 * hard step bound. The primitive plan is therefore restricted to `execute`.
 */
export function validateCapabilityPublication(publication: CapabilityPublication): void {
  if (!/^cap:\/\/[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/.test(publication.id)) {
    throw new Error("Capability id must match cap://name/vN");
  }
  validateFields(publication.inputs, "inputs");
  validateFields(publication.outputs, "outputs");
  if (publication.primitivePlan.length === 0 || publication.primitivePlan.length > MAX_PLAN_STEPS) {
    throw new Error(`Capability primitive plan must contain 1-${MAX_PLAN_STEPS} steps`);
  }
  if (publication.executionPlan.length !== publication.primitivePlan.length) {
    throw new Error("Capability primitive and execution plans must have equal length");
  }
  for (const primitive of publication.primitivePlan) {
    if (primitive !== "execute") {
      throw new Error(`Primitive ${primitive} is outside the deterministic capability subset`);
    }
  }
  for (const [index, step] of publication.executionPlan.entries()) validateStep(step, index);
  for (const kind of RESOURCE_KINDS) {
    const amount = publication.cost[kind];
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Invalid capability cost ${kind}`);
  }
  for (const kind of Object.keys(publication.cost)) {
    if (!(RESOURCE_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Capability cost contains unknown resource ${kind}`);
    }
  }

  if (publication.tests.length === 0 || publication.tests.length > MAX_TEST_VECTORS) {
    throw new Error(`Capability must include 1-${MAX_TEST_VECTORS} observable test vectors`);
  }
  for (const [index, rawTest] of publication.tests.entries()) {
    const test = jsonObject(rawTest, `capability test ${index}`);
    if (!("input" in test) || !("output" in test)) {
      throw new Error(`Capability test ${index} must contain input and output`);
    }
    const actual = executeValidatedPlan(publication, test.input!);
    if (canonicalJson(actual) !== canonicalJson(test.output as JsonValue)) {
      throw new Error(`Capability test ${index} does not match its execution plan`);
    }
  }
}

/** Validate an invocation and execute its bounded plan without side effects. */
export function executeCapabilityPlan(
  capability: Pick<CapabilityState, "inputs" | "outputs" | "primitivePlan" | "executionPlan">,
  input: JsonValue,
): JsonObject {
  if (capability.primitivePlan.length === 0 || capability.primitivePlan.length > MAX_PLAN_STEPS) {
    throw new Error("Capability plan length is outside the deterministic bound");
  }
  if (capability.primitivePlan.length !== capability.executionPlan.length) {
    throw new Error("Capability primitive and execution plans have different lengths");
  }
  if (capability.primitivePlan.some((primitive) => primitive !== "execute")) {
    throw new Error("Capability contains an unsupported primitive");
  }
  for (const [index, step] of capability.executionPlan.entries()) validateStep(step, index);
  validateFields(capability.inputs, "inputs");
  validateFields(capability.outputs, "outputs");
  return executeValidatedPlan(capability, input);
}

export function createCapabilityState(
  ownerId: string,
  tick: number,
  publication: CapabilityPublication,
): CapabilityState {
  validateCapabilityPublication(publication);
  const version = Number.parseInt(publication.id.match(/\/v([1-9][0-9]*)$/)?.[1] ?? "", 10);
  return {
    id: publication.id,
    ownerId,
    version,
    inputs: [...publication.inputs],
    outputs: [...publication.outputs],
    primitivePlan: [...publication.primitivePlan],
    executionPlan: structuredClone(publication.executionPlan),
    tests: structuredClone(publication.tests) as CapabilityState["tests"],
    cost: { ...publication.cost },
    createdTick: tick,
    usageCount: 0,
    successCount: 0,
  };
}

function executeValidatedPlan(
  capability: Pick<CapabilityPublication, "inputs" | "outputs" | "executionPlan">,
  input: JsonValue,
): JsonObject {
  const workspace = structuredClone(jsonObject(input, "capability input"));
  for (const name of capability.inputs) {
    if (!Object.hasOwn(workspace, name)) throw new Error(`Capability input is missing ${name}`);
  }

  for (const step of capability.executionPlan) {
    switch (step.op) {
      case "copy":
        workspace[step.to] = structuredClone(requiredField(workspace, step.from));
        break;
      case "sum": {
        let sum = 0n;
        for (const field of step.inputs) {
          const value = requiredField(workspace, field);
          if (typeof value !== "number" || !Number.isSafeInteger(value)) {
            throw new Error(`Capability sum input ${field} must be a safe integer`);
          }
          sum += BigInt(value);
        }
        if (sum < BigInt(Number.MIN_SAFE_INTEGER) || sum > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("Capability sum exceeds safe-integer range");
        }
        workspace[step.output] = Number(sum);
        break;
      }
      case "concat": {
        const values = step.inputs.map((field) => {
          const value = requiredField(workspace, field);
          if (typeof value !== "string") throw new Error(`Capability concat input ${field} must be a string`);
          return value;
        });
        const output = values.join(step.separator);
        if (output.length > MAX_CONCAT_LENGTH) throw new Error("Capability concat output exceeds deterministic bound");
        workspace[step.output] = output;
        break;
      }
      case "literal":
        workspace[step.output] = structuredClone(step.value);
        break;
    }
  }

  const output: JsonObject = {};
  for (const name of capability.outputs) output[name] = structuredClone(requiredField(workspace, name));
  return output;
}

function validateStep(step: CapabilityPlanStep, index: number): void {
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Capability step ${index} must be an object`);
  switch (step.op) {
    case "copy":
      validateField(step.from, `executionPlan[${index}].from`);
      validateField(step.to, `executionPlan[${index}].to`);
      break;
    case "sum":
    case "concat":
      validateFields(step.inputs, `executionPlan[${index}].inputs`);
      validateField(step.output, `executionPlan[${index}].output`);
      if (step.op === "concat") {
        if (typeof step.separator !== "string") {
          throw new Error(`executionPlan[${index}].separator must be a string`);
        }
        if (step.separator.length > 64) {
          throw new Error(`executionPlan[${index}].separator is too long`);
        }
      }
      break;
    case "literal":
      validateField(step.output, `executionPlan[${index}].output`);
      canonicalJson(step.value);
      break;
    default:
      throw new Error(`Unknown capability operation ${String((step as { op?: unknown }).op)}`);
  }
}

function validateFields(fields: readonly string[], label: string): void {
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > MAX_INTERFACE_FIELDS) {
    throw new Error(`Capability ${label} must contain 1-${MAX_INTERFACE_FIELDS} fields`);
  }
  const unique = new Set<string>();
  for (const field of fields) {
    validateField(field, label);
    if (unique.has(field)) throw new Error(`Capability ${label} contains duplicate ${field}`);
    unique.add(field);
  }
}

function validateField(field: unknown, label: string): asserts field is string {
  if (typeof field !== "string" || !FIELD_NAME.test(field)) throw new Error(`${label} contains an invalid field name`);
}

function requiredField(object: JsonObject, field: string): JsonValue {
  if (!Object.hasOwn(object, field)) throw new Error(`Capability workspace is missing ${field}`);
  return object[field]!;
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  canonicalJson(value);
  return value as JsonObject;
}
