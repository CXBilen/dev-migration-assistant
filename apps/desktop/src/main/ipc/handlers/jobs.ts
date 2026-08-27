import type { HandlerMap } from '../router'
import type { HandlerDeps } from './deps'

export type JobHandlers = Pick<HandlerMap, 'jobs:get' | 'jobs:cancel' | 'jobs:list'>

export function jobHandlers(deps: HandlerDeps): JobHandlers {
  const { jobs } = deps.core
  return {
    'jobs:get': (input) => jobs.get(input.jobId),
    'jobs:cancel': (input) => jobs.cancel(input.jobId),
    'jobs:list': () => jobs.list(),
  }
}
