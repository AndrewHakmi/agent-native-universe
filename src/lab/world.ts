import type { JsonObject, JsonValue } from "../core/types.js";
import { assertRoleNeutralGenesis, createGenesisAgents } from "./agent-factory.js";
import { createCapabilityState } from "./capability-registry.js";
import { hashValue } from "./canonical.js";
import { validateGenesisConfig } from "./config.js";
import { observeWorld } from "./environment.js";
import { IndependentEvaluator } from "./evaluator.js";
import type { LabEventRecorder } from "./event-recorder.js";
import { createLabEvent } from "./events.js";
import { deterministicId } from "./ids.js";
import {
  LAB_ENGINE_VERSION,
  LAB_POLICY_ID,
  LAB_TASK_GENERATOR_ID,
} from "./manifest.js";
import { computeMetrics } from "./metrics.js";
import { NeutralPolicy, type NeutralPolicyRandomSource } from "./neutral-policy.js";
import { PressureEngine } from "./pressure-engine.js";
import { initialWorldState, reduceWorldEvent } from "./reducer.js";
import { RESOURCE_KINDS, ResourcePhysics } from "./resource-physics.js";
import { DeterministicRng } from "./rng.js";
import { DeterministicTaskStream } from "./task-stream.js";
import {
  LAB_SCHEMA_VERSION,
  PPM,
  type Checkpoint,
  type GenesisConfig,
  type LabAgentState,
  type LabEvent,
  type LabEventDraft,
  type MetricsSnapshot,
  type Observation,
  type PrimitiveActionType,
  type ResourceVector,
  type RunManifest,
  type SubmissionState,
  type WorldAction,
  type WorldState,
} from "./types.js";

export interface LogicalPolicy {
  decide(observation: Observation, agent: LabAgentState, rng: NeutralPolicyRandomSource): WorldAction[];
}

export interface LogicalUniverseOptions {
  policy?: LogicalPolicy;
  onMetrics?: (snapshot: MetricsSnapshot) => void | Promise<void>;
  onCheckpoint?: (checkpoint: Checkpoint) => void | Promise<void>;
}

interface Decision {
  actorId: string;
  localIndex: number;
  action: WorldAction;
}

const UNSUPPORTED_ACTIONS = new Set<PrimitiveActionType>([
  "spawn", "clone", "merge", "reserve", "trade",
]);

/** Deterministic, event-sourced logical Genesis universe. */
export class LogicalUniverse {
  readonly manifest: RunManifest;
  readonly config: GenesisConfig;
  readonly recorder: LabEventRecorder;

  readonly #policy: LogicalPolicy;
  readonly #onMetrics: LogicalUniverseOptions["onMetrics"];
  readonly #onCheckpoint: LogicalUniverseOptions["onCheckpoint"];
  readonly #physics = new ResourcePhysics();
  readonly #evaluator = new IndependentEvaluator();
  readonly #pressure: PressureEngine;
  readonly #taskStream: DeterministicTaskStream;
  readonly #policyRng: DeterministicRng;
  readonly #pressureRng: DeterministicRng;
  readonly #resolutionRng: DeterministicRng;
  readonly #initialAgentTotals: ResourceVector;

  #world: WorldState;
  #initialTotal: ResourceVector | undefined;
  #nextTick = 1;
  #initialized = false;
  #tickRunning = false;
  #observations: Observation[] = [];

  constructor(
    manifest: RunManifest,
    config: GenesisConfig,
    recorder: LabEventRecorder,
    options: LogicalUniverseOptions = {},
  ) {
    validateGenesisConfig(config);
    if (manifest.schemaVersion !== LAB_SCHEMA_VERSION) throw new Error("Manifest schema does not match the lab");
    if (
      manifest.engineVersion !== LAB_ENGINE_VERSION
      || manifest.mode !== "logical"
      || manifest.policyId !== LAB_POLICY_ID
      || manifest.taskGeneratorId !== LAB_TASK_GENERATOR_ID
    ) {
      throw new Error("Manifest implementation identity does not match this logical engine");
    }
    if (manifest.experimentId !== config.experimentId) throw new Error("Manifest experiment does not match config");
    if (manifest.seed !== config.seed) throw new Error("Manifest seed does not match config");
    if (manifest.configHash !== hashValue(config)) throw new Error("Manifest configHash does not match config");
    if (recorder.manifest.runId !== manifest.runId || recorder.manifest.universeId !== manifest.universeId) {
      throw new Error("Recorder belongs to another run or universe");
    }

    this.manifest = structuredClone(manifest);
    this.config = structuredClone(config);
    this.recorder = recorder;
    this.#policy = options.policy ?? new NeutralPolicy();
    this.#onMetrics = options.onMetrics;
    this.#onCheckpoint = options.onCheckpoint;
    const rootRng = new DeterministicRng(hashValue({
      domain: "agent-native-universe/lab/logical-universe/v1",
      runId: manifest.runId,
      universeId: manifest.universeId,
      seed: config.seed,
    }));
    this.#taskStream = new DeterministicTaskStream(config.taskStream, rootRng.fork("tasks"));
    this.#pressure = new PressureEngine(config.pressures);
    this.#policyRng = rootRng.fork("policy");
    this.#pressureRng = rootRng.fork("pressure");
    this.#resolutionRng = rootRng.fork("resolution");
    this.#world = initialWorldState(manifest);
    this.#initialAgentTotals = multiplyResources(config.initialResources, config.agents);
  }

  static create(
    manifest: RunManifest,
    config: GenesisConfig,
    recorder: LabEventRecorder,
    options: LogicalUniverseOptions = {},
  ): LogicalUniverse {
    return new LogicalUniverse(manifest, config, recorder, options);
  }

  state(): WorldState {
    return structuredClone(this.#world);
  }

  lastObservations(): Observation[] {
    return structuredClone(this.#observations);
  }

  async initialize(): Promise<WorldState> {
    if (this.#initialized) return this.state();
    if (this.recorder.lastSeq !== 0) throw new Error("LogicalUniverse v1 requires an empty event recorder");

    await this.#commit({
      tick: 0,
      phase: "genesis",
      type: "run.started",
      data: toJsonObject({ treasury: this.config.treasuryResources }),
    });
    const agents = createGenesisAgents(this.config);
    assertRoleNeutralGenesis(agents);
    for (const agent of agents) {
      await this.#commit({
        tick: 0,
        phase: "genesis",
        type: "agent.created",
        actorId: agent.id,
        data: toJsonObject({ agent }),
      });
    }
    this.#initialTotal = totalResources(this.#world);
    this.#initialized = true;
    return this.state();
  }

  async run(): Promise<WorldState> {
    await this.initialize();
    while (this.#nextTick <= this.config.ticks) await this.tick();
    if (!this.#world.completed) {
      await this.#commit({
        tick: this.config.ticks,
        phase: "completion",
        type: "run.completed",
        data: { ticks: this.config.ticks, events: this.recorder.lastSeq + 1 },
      });
      await this.#onCheckpoint?.(this.#checkpoint(this.config.ticks));
    }
    return this.state();
  }

  async tick(): Promise<WorldState> {
    await this.initialize();
    if (this.#world.completed) throw new Error("Run is already completed");
    if (this.#nextTick > this.config.ticks) throw new Error("Configured tick limit reached");
    if (this.#tickRunning) throw new Error("A logical tick is already running");
    this.#tickRunning = true;
    const tick = this.#nextTick;
    try {
      await this.#applyPressures(tick);
      await this.#expireTasks(tick);
      await this.#generateTasks(tick);
      const decisions = await this.#decide(tick);
      const pendingEvaluation: string[] = [];
      const ordered = this.#resolutionRng.fork(tick).shuffle(decisions);
      for (const decision of ordered) await this.#resolve(decision, tick, pendingEvaluation);
      await this.#evaluate(pendingEvaluation, tick);

      const recordMetrics = tick % this.config.metricEvery === 0 || tick === this.config.ticks;
      if (recordMetrics) {
        const metrics = computeMetrics(this.#world, this.#initialAgentTotals);
        await this.#commit({
          tick,
          phase: "metrics",
          type: "metrics.recorded",
          data: toJsonObject({ metrics }),
        });
        await this.#onMetrics?.(structuredClone(metrics));
      }

      await this.#commit({
        tick,
        phase: "upkeep",
        type: "tick.completed",
        data: { tick },
      });
      this.#nextTick += 1;
      this.#assertConserved();

      const checkpoint = tick % this.config.checkpointEvery === 0 && tick !== this.config.ticks;
      if (checkpoint && this.#onCheckpoint) await this.#onCheckpoint(this.#checkpoint(tick));
      return this.state();
    } finally {
      this.#tickRunning = false;
    }
  }

  async #applyPressures(tick: number): Promise<void> {
    const result = this.#pressure.forTick(tick, this.#world, this.#pressureRng.fork(tick));
    for (const event of result.events) await this.#commit(event);
    for (const agentId of result.retiredAgentIds) {
      await this.#commit({
        tick,
        phase: "pressure",
        type: "agent.retired",
        actorId: agentId,
        data: { agentId, retiredTick: tick, reason: "pressure" },
      });
    }
  }

  async #expireTasks(tick: number): Promise<void> {
    const expired = Object.values(this.#world.tasks)
      .filter((task) => task.status !== "completed" && task.status !== "expired" && task.deadlineTick < tick)
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    for (const task of expired) {
      await this.#commit({
        tick,
        phase: "task_generation",
        type: "task.expired",
        data: { taskId: task.id },
      });
    }
  }

  async #generateTasks(tick: number): Promise<void> {
    const backlog = Object.values(this.#world.tasks)
      .filter((task) => task.status !== "completed" && task.status !== "expired").length;
    const capacity = Math.max(0, this.config.taskStream.maxBacklog - backlog);
    const scaled = safePpmMultiply(this.config.taskStream.tasksPerTick, this.#world.physics.taskLoadPpm);
    const count = Math.min(capacity, scaled);
    for (const generated of this.#taskStream.generate(tick, count)) {
      this.#evaluator.registerOracle(generated.task.id, generated.expected);
      await this.#commit({
        tick,
        phase: "task_generation",
        type: "task.created",
        data: toJsonObject({ task: generated.task }),
      });
    }
  }

  async #decide(tick: number): Promise<Decision[]> {
    const immutableState = structuredClone(this.#world);
    const agentIds = Object.values(immutableState.agents)
      .filter((agent) => agent.active)
      .map((agent) => agent.id)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const observations: Observation[] = [];
    const decisions: Decision[] = [];
    for (const agentId of agentIds) {
      const observation = observeWorld(immutableState, agentId);
      observations.push(structuredClone(observation));
      try {
        const actions = this.#policy.decide(
          deepFreeze(structuredClone(observation)),
          deepFreeze(structuredClone(immutableState.agents[agentId]!)),
          this.#policyRng,
        );
        for (const [localIndex, action] of actions.entries()) {
          decisions.push({ actorId: agentId, localIndex, action: structuredClone(action) });
        }
      } catch (error) {
        await this.#violation(agentId, "reason", `policy error: ${errorMessage(error)}`, tick);
      }
    }
    this.#observations = observations;
    return decisions;
  }

  async #resolve(decision: Decision, tick: number, pendingEvaluation: string[]): Promise<void> {
    const { actorId, action } = decision;
    if (!this.#world.agents[actorId]?.active) return;
    if (!await this.#pay(actorId, action.type, tick)) return;
    if (UNSUPPORTED_ACTIONS.has(action.type)) {
      await this.#violation(actorId, action.type, `${action.type} is unsupported in logical v1`, tick);
      return;
    }

    try {
      switch (action.type) {
        case "observe":
        case "reason":
          return;
        case "claimTask": {
          const task = this.#world.tasks[action.taskId];
          // The decision phase reads one immutable snapshot. Another agent may
          // legitimately win before this action is resolved; that is paid
          // contention, not a policy violation.
          if (!task || task.status !== "available") return;
          await this.#commit({
            tick, phase: "resolution", type: "task.claimed", actorId,
            data: { taskId: action.taskId, agentId: actorId },
          });
          return;
        }
        case "execute": {
          const task = this.#world.tasks[action.taskId];
          if (!task || task.status !== "claimed" || task.claimedBy !== actorId) {
            throw new Error(`Task ${action.taskId} is not claimed by ${actorId}`);
          }
          await this.#commit({
            tick,
            phase: "resolution",
            type: "memory.stored",
            actorId,
            data: toJsonObject({
              agentId: actorId,
              key: NeutralPolicy.resultMemoryKey(action.taskId),
              value: action.result,
              action: "execute",
            }),
          });
          return;
        }
        case "submit": {
          const task = this.#world.tasks[action.taskId];
          if (!task || task.status !== "claimed" || task.claimedBy !== actorId) {
            throw new Error(`Task ${action.taskId} is not claimed by ${actorId}`);
          }
          const submission: SubmissionState = {
            id: deterministicId("submission", this.manifest.runId, action.taskId, actorId),
            taskId: action.taskId,
            agentId: actorId,
            result: structuredClone(action.result),
            submittedTick: tick,
            accepted: false,
            qualityPpm: 0,
            latencyTicks: 0,
          };
          await this.#commit({
            tick, phase: "resolution", type: "task.submitted", actorId,
            data: toJsonObject({ submission }),
          });
          pendingEvaluation.push(submission.id);
          return;
        }
        case "verify": {
          if (!this.#world.submissions[action.submissionId]) throw new Error(`Unknown submission ${action.submissionId}`);
          return;
        }
        case "connect": {
          this.#requireActiveTarget(actorId, action.targetId);
          if (this.#findLink(actorId, action.targetId)) return;
          const [left, right] = [actorId, action.targetId].sort();
          const link = {
            id: deterministicId("link", this.manifest.runId, left!, right!),
            left: left!,
            right: right!,
            strengthPpm: PPM,
            createdTick: tick,
            lastUsedTick: tick,
          };
          await this.#commit({
            tick, phase: "resolution", type: "link.created", actorId, targetId: action.targetId,
            data: toJsonObject({ link }),
          });
          return;
        }
        case "disconnect": {
          const link = this.#findLink(actorId, action.targetId);
          if (!link) throw new Error("Agents are not connected");
          await this.#commit({
            tick, phase: "resolution", type: "link.removed", actorId, targetId: action.targetId,
            data: { linkId: link.id },
          });
          return;
        }
        case "send": {
          this.#requireActiveTarget(actorId, action.targetId);
          const link = this.#findLink(actorId, action.targetId);
          if (!link) throw new Error("Messages require an active link");
          await this.#commit({
            tick, phase: "resolution", type: "message.sent", actorId, targetId: action.targetId,
            data: toJsonObject({ agentId: actorId, targetId: action.targetId, payload: action.payload }),
          });
          await this.#commit({
            tick, phase: "resolution", type: "link.used", actorId, targetId: action.targetId,
            data: { linkId: link.id },
          });
          return;
        }
        case "store":
          await this.#commit({
            tick, phase: "resolution", type: "memory.stored", actorId,
            data: toJsonObject({ agentId: actorId, key: action.key, value: action.value }),
          });
          return;
        case "retrieve": {
          const memory = this.#world.agents[actorId]!.memory;
          if (!Object.hasOwn(memory, action.key)) throw new Error(`Unknown memory key ${action.key}`);
          await this.#commit({
            tick, phase: "resolution", type: "memory.retrieved", actorId,
            data: toJsonObject({ agentId: actorId, key: action.key, value: memory[action.key] }),
          });
          return;
        }
        case "publishCapability": {
          if (this.#world.capabilities[action.capability.id]) throw new Error(`Capability ${action.capability.id} already exists`);
          const capability = createCapabilityState(actorId, tick, action.capability);
          await this.#commit({
            tick, phase: "resolution", type: "capability.published", actorId,
            data: toJsonObject({ capability }),
          });
          return;
        }
        case "useCapability": {
          if (!this.#world.capabilities[action.capabilityId]) throw new Error(`Unknown capability ${action.capabilityId}`);
          await this.#commit({
            tick, phase: "resolution", type: "capability.used", actorId,
            data: toJsonObject({ agentId: actorId, capabilityId: action.capabilityId, input: action.input, success: true }),
          });
          return;
        }
        case "transfer": {
          this.#requireActiveTarget(actorId, action.targetId);
          if (!Number.isSafeInteger(action.amount) || action.amount <= 0) throw new Error("Transfer amount must be positive");
          if (this.#world.agents[actorId]!.resources[action.resource] < action.amount) throw new Error(`Insufficient ${action.resource}`);
          await this.#commit({
            tick, phase: "resolution", type: "resource.transferred", actorId, targetId: action.targetId,
            data: { fromId: actorId, toId: action.targetId, resource: action.resource, amount: action.amount },
          });
          return;
        }
        case "spawn":
        case "clone":
        case "merge":
        case "reserve":
        case "trade":
          return;
      }
    } catch (error) {
      await this.#violation(actorId, action.type, errorMessage(error), tick);
    }
  }

  async #pay(actorId: string, action: PrimitiveActionType, tick: number): Promise<boolean> {
    let cost: ResourceVector;
    try {
      cost = this.#physics.scaledCost(this.config.costs[action], this.#world.physics);
    } catch (error) {
      await this.#violation(actorId, action, `cost unavailable: ${errorMessage(error)}`, tick);
      return false;
    }
    const agent = this.#world.agents[actorId]!;
    if (!this.#physics.canAfford(agent.resources, cost)) {
      // Exhaustion is an enforced physical boundary, not malicious behavior.
      // The rejected attempt changes no state and cannot create an unbounded
      // violation-event storm after a balance reaches zero.
      return false;
    }
    await this.#commit({
      tick,
      phase: "resolution",
      type: "resource.spent",
      actorId,
      data: toJsonObject({
        agentId: actorId,
        cost,
        action,
      }),
    });
    return true;
  }

  async #evaluate(submissionIds: readonly string[], tick: number): Promise<void> {
    for (const submissionId of submissionIds) {
      const submission = this.#world.submissions[submissionId];
      if (!submission) continue;
      const task = this.#world.tasks[submission.taskId];
      if (!task) continue;
      try {
        const evaluation = this.#evaluator.evaluate(task, submission.id, submission.agentId, submission.result, tick);
        await this.#commit({
          tick, phase: "evaluation", type: "task.evaluated", actorId: submission.agentId,
          data: toJsonObject({ ...evaluation, completedTick: tick }),
        });
        if (
          evaluation.accepted
          && this.#physics.canAfford(this.#world.treasury, this.config.acceptedTaskReward)
        ) {
          for (const resource of RESOURCE_KINDS) {
            const amount = this.config.acceptedTaskReward[resource];
            if (amount === 0) continue;
            await this.#commit({
              tick,
              phase: "evaluation",
              type: "resource.transferred",
              actorId: "@treasury",
              targetId: submission.agentId,
              data: {
                fromId: "@treasury",
                toId: submission.agentId,
                resource,
                amount,
                reason: "accepted-task",
                taskId: task.id,
              },
            });
          }
        }
      } catch (error) {
        await this.#violation(submission.agentId, "verify", `evaluation error: ${errorMessage(error)}`, tick);
      }
    }
  }

  async #violation(actorId: string, action: PrimitiveActionType, reason: string, tick: number): Promise<void> {
    await this.#commit({
      tick,
      phase: "resolution",
      type: "violation.recorded",
      actorId,
      data: { agentId: actorId, action, reason, count: 1 },
    });
  }

  async #commit(draft: LabEventDraft): Promise<LabEvent> {
    const preview = createLabEvent(this.manifest, draft, this.recorder.lastSeq + 1, this.recorder.lastHash);
    const next = reduceWorldEvent(this.#world, preview);
    const appended = await this.recorder.append(draft);
    if (appended.hash !== preview.hash || appended.seq !== preview.seq) {
      throw new Error("Recorder changed between event preview and append");
    }
    this.#world = next;
    return appended;
  }

  #findLink(left: string, right: string): WorldState["links"][string] | undefined {
    return Object.values(this.#world.links).find((link) => (
      (link.left === left && link.right === right) || (link.left === right && link.right === left)
    ));
  }

  #requireActiveTarget(actorId: string, targetId: string): void {
    if (targetId === actorId) throw new Error("Agent cannot target itself");
    if (!this.#world.agents[targetId]?.active) throw new Error(`Target ${targetId} is not active`);
  }

  #assertConserved(): void {
    if (!this.#initialTotal) return;
    this.#physics.assertConserved(this.#initialTotal, totalResources(this.#world));
  }

  #checkpoint(tick: number): Checkpoint {
    const state = this.state();
    return {
      schemaVersion: LAB_SCHEMA_VERSION,
      runId: this.manifest.runId,
      universeId: this.manifest.universeId,
      tick,
      seq: this.recorder.lastSeq,
      eventHash: this.recorder.lastHash,
      stateHash: hashValue(state),
      state,
    };
  }
}

export function createLogicalUniverse(
  manifest: RunManifest,
  config: GenesisConfig,
  recorder: LabEventRecorder,
  options: LogicalUniverseOptions = {},
): LogicalUniverse {
  return new LogicalUniverse(manifest, config, recorder, options);
}

function totalResources(state: WorldState): ResourceVector {
  const total = { ...state.treasury };
  for (const agent of Object.values(state.agents)) {
    for (const resource of RESOURCE_KINDS) total[resource] = safeAdd(total[resource], agent.resources[resource]);
  }
  return total;
}

function multiplyResources(resources: ResourceVector, count: number): ResourceVector {
  const output = { ...resources };
  for (const resource of RESOURCE_KINDS) {
    const value = BigInt(resources[resource]) * BigInt(count);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Initial ${resource} total exceeds safe integer range`);
    output[resource] = Number(value);
  }
  return output;
}

function safeAdd(left: number, right: number): number {
  const value = BigInt(left) + BigInt(right);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Resource total exceeds safe integer range");
  return Number(value);
}

function safePpmMultiply(value: number, multiplierPpm: number): number {
  const result = (BigInt(value) * BigInt(multiplierPpm)) / BigInt(PPM);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Task load exceeds safe integer range");
  return Number(result);
}

function toJsonObject(value: unknown): JsonObject {
  return structuredClone(value) as JsonObject;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
