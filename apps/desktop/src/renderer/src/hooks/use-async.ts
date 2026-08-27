import type { SerializedError } from '@devmig/model'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toSerializedError } from '../lib/errors'

export interface AsyncState<T> {
  data: T | null
  error: SerializedError | null
  loading: boolean
  reload: () => void
}

/** Loads a value once on mount (and on `reload` / when `deps` change). Errors are normalized. */
export function useAsyncValue<T>(load: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<{
    data: T | null
    error: SerializedError | null
    loading: boolean
  }>({
    data: null,
    error: null,
    loading: true,
  })
  const [generation, setGeneration] = useState(0)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  useEffect(() => {
    let active = true
    loadRef
      .current()
      .then((data) => {
        if (active) setState({ data, error: null, loading: false })
      })
      .catch((err: unknown) => {
        if (active) setState({ data: null, error: toSerializedError(err), loading: false })
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller
  }, [generation, ...deps])
  const reload = useCallback(() => setGeneration((g) => g + 1), [])
  return { ...state, reload }
}

export interface AsyncAction<Args extends unknown[], R> {
  run: (...args: Args) => Promise<R | undefined>
  pending: boolean
  error: SerializedError | null
  clearError: () => void
}

/** Runs an async action from an event handler and exposes pending/error state. */
export function useAsyncAction<Args extends unknown[], R>(
  action: (...args: Args) => Promise<R>,
): AsyncAction<Args, R> {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SerializedError | null>(null)
  const actionRef = useRef(action)
  useEffect(() => {
    actionRef.current = action
  })
  const run = useCallback(async (...args: Args): Promise<R | undefined> => {
    setPending(true)
    setError(null)
    try {
      return await actionRef.current(...args)
    } catch (err) {
      setError(toSerializedError(err))
      return undefined
    } finally {
      setPending(false)
    }
  }, [])
  const clearError = useCallback(() => setError(null), [])
  return { run, pending, error, clearError }
}
