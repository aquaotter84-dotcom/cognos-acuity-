// Council — cognitive operator registry. Registers every council stage with the
// agent registry so the orchestrator can dispatch them as pipeline stages.
// Phase 2: Observer, Strategist, Critic, Governor.
// Phase 3: Specialist (execution), Synthesizer (integration).

import { observerAgent } from "./observer.js";
import { strategistAgent } from "./strategist.js";
import { specialistAgent } from "./specialist.js";
import { synthesizerAgent } from "./synthesizer.js";
import { criticAgent } from "./critic.js";
import { governorAgent } from "./governor.js";
import { webSearchAgent } from "./webSearch.js";

export { observerAgent, strategistAgent, specialistAgent, synthesizerAgent, criticAgent, governorAgent, webSearchAgent };

export function registerCouncil(registry) {
  registry.register(observerAgent.name, observerAgent);
  registry.register(strategistAgent.name, strategistAgent);
  registry.register(specialistAgent.name, specialistAgent);
  registry.register(synthesizerAgent.name, synthesizerAgent);
  registry.register(criticAgent.name, criticAgent);
  registry.register(governorAgent.name, governorAgent);
  registry.register(webSearchAgent.name, webSearchAgent);
}