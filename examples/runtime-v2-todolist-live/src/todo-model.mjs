// Pure TodoList state logic. No DOM, no network. R08-safe.

// Stable unique ID generator: monotonic counter within a session.
// We expose a factory so each store gets its own counter, keeping the
// functions pure and testable without shared mutable module state.
export function createIdGenerator() {
  let n = 0;
  return () => `t${++n}`;
}

export function createStore({ idGenerator = createIdGenerator() } = {}) {
  return {
    todos: [],
    filter: 'all',
    _idGenerator: idGenerator,
  };
}

function isNonEmptyTitle(title) {
  return typeof title === 'string' && title.trim().length > 0;
}

// R01: add a todo only when the title is non-empty (after trim).
// Returns a NEW store object; does not mutate the input.
export function createTodo(store, title) {
  if (!isNonEmptyTitle(title)) {
    return store; // R01: blank input must not create a todo
  }
  const todo = {
    id: store._idGenerator(),
    title: title.trim(),
    completed: false,
  };
  return { ...store, todos: [...store.todos, todo] };
}

// R03: toggle completion of one todo by id. Id (R02) is never changed.
export function toggleTodo(store, id) {
  return {
    ...store,
    todos: store.todos.map((t) =>
      t.id === id ? { ...t, completed: !t.completed } : t,
    ),
  };
}

// R04: edit a todo title. Blank edit must not destroy the existing title.
// Id (R02) and completed state are preserved.
export function editTodo(store, id, title) {
  if (!isNonEmptyTitle(title)) {
    return store; // R04: blank edit is rejected, original title untouched
  }
  return {
    ...store,
    todos: store.todos.map((t) =>
      t.id === id ? { ...t, title: title.trim() } : t,
    ),
  };
}

// R05: delete exactly the targeted todo by id; others untouched.
export function deleteTodo(store, id) {
  return {
    ...store,
    todos: store.todos.filter((t) => t.id !== id),
  };
}

// R06: switch the active filter view.
export function setFilter(store, filter) {
  if (filter !== 'all' && filter !== 'active' && filter !== 'completed') {
    return store;
  }
  return { ...store, filter };
}

// R06: subset of todos visible under the current filter.
export function filterTodos(store, filter = store.filter) {
  switch (filter) {
    case 'active':
      return store.todos.filter((t) => !t.completed);
    case 'completed':
      return store.todos.filter((t) => t.completed);
    case 'all':
    default:
      return [...store.todos];
  }
}

// R06: counts used by the UI to keep counters consistent with data.
export function counts(store) {
  let active = 0;
  let completed = 0;
  for (const t of store.todos) {
    if (t.completed) completed += 1;
    else active += 1;
  }
  return { total: store.todos.length, active, completed };
}
