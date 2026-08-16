#!/usr/bin/env node
import { Universe } from "../runtime/universe.js";
const [command] = process.argv.slice(2);
if (!command || command === "help") { console.log(`Agent Native Universe (anu)\n\nCommands:\n  anu demo        run an in-memory two-agent synchronization demo\n  anu principles  print core runtime laws`); process.exit(0); }
if (command === "principles") { console.log(["1. Local worlds, explicit boundaries.","2. Edges are stateful computational objects.","3. Local sequential consistency; global parallelism.","4. Hard invariants are runtime-enforced, not prompt-enforced.","5. Topology and architecture are projections of the live graph.","6. No mandatory central orchestrator."].join("\n")); process.exit(0); }
if (command === "demo") { const o=(primary:string)=>({primary,secondary:[],antiGoals:[],weights:{}}); const u=new Universe(); const a=u.createAgent({objective:o("observe")}); const b=u.createAgent({objective:o("respond")}); a.activate(); b.activate(); const l=u.connect({left:a.id,right:b.id,fieldOwnership:{signal:"left",reply:"right"}}); l.mutate({author:a.id,delta:{signal:"ping"},informationGain:1}); l.mutate({author:b.id,delta:{reply:"pong"},utility:1}); console.log(JSON.stringify({projection:u.projection(),link:l.snapshot()},null,2)); process.exit(0); }
console.error(`Unknown command: ${command}`); process.exit(1);
