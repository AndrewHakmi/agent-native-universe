import { NotFoundError, ProtocolViolation } from "../core/errors.js";
import { LinkProtocol, type LinkProtocolSpec } from "../core/link-protocol.js";
import { NanoAgent, type NanoAgentSpec } from "../core/nano-agent.js";
import type { AgentId, LinkId, ObjectiveVector } from "../core/types.js";
export interface UniverseSnapshot { agents: ReturnType<NanoAgent["snapshot"]>[]; links: ReturnType<LinkProtocol["snapshot"]>[]; }
export class Universe {
 readonly agents=new Map<AgentId,NanoAgent>(); readonly links=new Map<LinkId,LinkProtocol>();
 createAgent(spec:NanoAgentSpec){const a=new NanoAgent(spec);this.agents.set(a.id,a);return a;}
 connect(spec:LinkProtocolSpec){const left=this.requireAgent(spec.left),right=this.requireAgent(spec.right);const link=new LinkProtocol(spec);this.links.set(link.id,link);left.addLink(link.id);right.addLink(link.id);link.activate();return link;}
 disconnect(id:LinkId){const link=this.requireLink(id),s=link.snapshot();link.retire();this.requireAgent(s.left).removeLink(id);this.requireAgent(s.right).removeLink(id);this.links.delete(id);}
 cloneAgent(id:AgentId,overrides:Partial<NanoAgentSpec>={}){const clone=this.requireAgent(id).clone(overrides);this.agents.set(clone.id,clone);return clone;}
 splitAgent(id:AgentId,objectives:ObjectiveVector[]){const parent=this.requireAgent(id),children=parent.split(objectives);for(const c of children)this.agents.set(c.id,c);parent.sleep();return children;}
 mergeAgents(aId:AgentId,bId:AgentId,objective:ObjectiveVector){const a=this.requireAgent(aId),b=this.requireAgent(bId),merged=NanoAgent.merge(a,b,objective);this.agents.set(merged.id,merged);a.sleep();b.sleep();return merged;}
 tick(now=Date.now()){for(const link of this.links.values())link.decay(now);for(const agent of this.agents.values()){const s=agent.snapshot();if(s.ttlMs!==undefined&&s.lifecycle!=="retired"&&now-s.createdAt>s.ttlMs)agent.retire();}}
 neighbors(id:AgentId){return this.requireAgent(id).snapshot().links.map(linkId=>this.requireLink(linkId).other(id));}
 strongestLinks(limit=10){return [...this.links.values()].sort((a,b)=>b.snapshot().strength-a.snapshot().strength).slice(0,limit);}
 projection(){const agents=[...this.agents.values()].map(a=>a.snapshot()),links=[...this.links.values()].map(l=>l.snapshot());return{nodes:agents.length,edges:links.length,activeAgents:agents.filter(a=>a.lifecycle==="active").length,activeLinks:links.filter(l=>l.lifecycle==="active"||l.lifecycle==="strengthening").length,averageStrength:links.length?links.reduce((s,l)=>s+l.strength,0)/links.length:0};}
 detectClusters(minStrength=0.5):AgentId[][]{const seen=new Set<AgentId>(),clusters:AgentId[][]=[];for(const id of this.agents.keys()){if(seen.has(id))continue;const cluster:AgentId[]=[],q:AgentId[]=[id];seen.add(id);while(q.length){const cur=q.shift()!;cluster.push(cur);for(const linkId of this.requireAgent(cur).snapshot().links){const link=this.requireLink(linkId);if(link.snapshot().strength<minStrength)continue;const n=link.other(cur);if(!seen.has(n)){seen.add(n);q.push(n);}}}clusters.push(cluster);}return clusters.sort((a,b)=>b.length-a.length);}
 assertIntegrity(){for(const[id,link]of this.links){const s=link.snapshot();if(!this.agents.has(s.left)||!this.agents.has(s.right))throw new ProtocolViolation(`link ${id} points to missing agent`);if(!this.requireAgent(s.left).snapshot().links.includes(id)||!this.requireAgent(s.right).snapshot().links.includes(id))throw new ProtocolViolation(`link ${id} not mirrored in agents`);}}
 snapshot():UniverseSnapshot{return{agents:[...this.agents.values()].map(a=>a.snapshot()),links:[...this.links.values()].map(l=>l.snapshot())};} requireAgent(id:AgentId){const x=this.agents.get(id);if(!x)throw new NotFoundError(`agent ${id} not found`);return x;} requireLink(id:LinkId){const x=this.links.get(id);if(!x)throw new NotFoundError(`link ${id} not found`);return x;}
}
