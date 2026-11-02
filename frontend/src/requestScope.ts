// A change of account cancels every in-flight private HTTP request, including mutations.
let scope = new AbortController();
export function privateRequestSignal() {
  return scope.signal;
}
export function resetPrivateRequests() {
  scope.abort();
  scope = new AbortController();
}
