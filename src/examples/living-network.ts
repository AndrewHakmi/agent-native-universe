import { Universe } from "../runtime/universe.js";

const objective = (primary: string) => ({
  primary,
  secondary: ["minimize_coordination_cost", "maximize_information_gain"],
  antiGoals: ["unsafe_external_write"],
  weights: { accuracy: 1, information: 0.8, cost: -0.2, risk: -1 }
});

const universe = new Universe();

const telemetry = universe.createAgent({
  objective: objective("observe platform telemetry"),
  capabilities: [{
    id: "telemetry.observe",
    accepts: ["anomaly"],
    produces: ["telemetry"],
    riskClass: "low"
  }],
  exposedState: { cpu: 0.82, latencyMs: 140, errorRate: 0.021 }
});

const detector = universe.createAgent({
  objective: objective("detect operational anomalies"),
  capabilities: [{
    id: "anomaly.detect",
    accepts: ["telemetry"],
    produces: ["anomaly"],
    riskClass: "low"
  }],
  needs: [{
    id: "need.telemetry",
    accepts: ["telemetry"],
    priority: 1,
    recurring: true,
    maxCommunicationCost: 8,
    minReliability: 0.5
  }],
  exposedState: { request: "latest telemetry" }
});

const responder = universe.createAgent({
  objective: objective("prepare safe remediation"),
  capabilities: [{
    id: "remediation.plan",
    accepts: ["anomaly"],
    produces: ["remediation"],
    riskClass: "medium"
  }],
  needs: [{
    id: "need.anomaly",
    accepts: ["anomaly"],
    priority: 0.9,
    recurring: true,
    maxCommunicationCost: 8,
    minReliability: 0.6
  }],
  exposedState: { readiness: "standby" }
});

telemetry.activate();
detector.activate();
responder.activate();

const report = await universe.evolve({
  rounds: 3,
  stepMs: 10,
  maxLinkTurnsPerRound: 2,
  maxNewLinksPerAgentPerRound: 2
});

console.log(JSON.stringify({
  report,
  projection: universe.projection(),
  clusters: universe.detectClusters(0.3),
  links: [...universe.links.values()].map(link => link.snapshot())
}, null, 2));
