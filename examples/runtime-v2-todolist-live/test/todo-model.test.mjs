import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  createIdGenerator,
  createTodo,
  toggleTodo,
  editTodo,
  deleteTodo,
  setFilter,
  filterTodos,
  counts,
} from '../src/todo-model.mjs';

function freshStore() {
  return createStore({ idGenerator: createIdGenerator() });
}

// R01 -----------------------------------------------------------------------
test('R01: blank and whitespace-only input does not create a todo', () => {
  let s = freshStore();
  s = createTodo(s, '');
  s = createTodo(s, '   ');
  s = createTodo(s, '\t\n');
  assert.equal(s.todos.length, 0);
});

test('R01: non-empty title creates a todo', () => {
  let s = freshStore();
  s = createTodo(s, '买菜');
  assert.equal(s.todos.length, 1);
  assert.equal(s.todos[0].title, '买菜');
  assert.equal(s.todos[0].completed, false);

  // surrounding whitespace is trimmed for the stored title
  s = createTodo(s, '  写代码  ');
  assert.equal(s.todos[1].title, '写代码');
});

// R02 -----------------------------------------------------------------------
test('R02: ids are unique within a session', () => {
  let s = freshStore();
  s = createTodo(s, 'a');
  s = createTodo(s, 'b');
  s = createTodo(s, 'c');
  const ids = s.todos.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('R02: editing title and toggling completion do not change the id', () => {
  let s = freshStore();
  s = createTodo(s, '买菜');
  const idBefore = s.todos[0].id;
  s = editTodo(s, idBefore, '买菜（折扣）');
  assert.equal(s.todos[0].id, idBefore);
  s = toggleTodo(s, idBefore);
  assert.equal(s.todos[0].id, idBefore);
  assert.equal(s.todos[0].completed, true);
  s = toggleTodo(s, idBefore);
  assert.equal(s.todos[0].completed, false);
  assert.equal(s.todos[0].id, idBefore);
});

// R03 -----------------------------------------------------------------------
test('R03: toggle flips completion both ways and only for the target', () => {
  let s = freshStore();
  s = createTodo(s, 'a');
  s = createTodo(s, 'b');
  const [idA, idB] = s.todos.map((t) => t.id);
  s = toggleTodo(s, idA);
  assert.equal(s.todos.find((t) => t.id === idA).completed, true);
  assert.equal(s.todos.find((t) => t.id === idB).completed, false);
  s = toggleTodo(s, idA);
  assert.equal(s.todos.find((t) => t.id === idA).completed, false);
});

// R04 -----------------------------------------------------------------------
test('R04: blank edit does not destroy the existing title', () => {
  let s = freshStore();
  s = createTodo(s, '买菜');
  const id = s.todos[0].id;
  s = editTodo(s, id, '   ');
  assert.equal(s.todos[0].title, '买菜');
  s = editTodo(s, id, '');
  assert.equal(s.todos[0].title, '买菜');
});

test('R04: non-empty edit updates the title, id and completion preserved', () => {
  let s = freshStore();
  s = createTodo(s, '买菜');
  const id = s.todos[0].id;
  s = toggleTodo(s, id);
  s = editTodo(s, id, '买水果');
  assert.equal(s.todos[0].title, '买水果');
  assert.equal(s.todos[0].id, id);
  assert.equal(s.todos[0].completed, true);
});

// R05 -----------------------------------------------------------------------
test('R05: delete by id removes only the target todo', () => {
  let s = freshStore();
  s = createTodo(s, 'a');
  s = createTodo(s, 'b');
  s = createTodo(s, 'c');
  const ids = s.todos.map((t) => t.id);
  s = deleteTodo(s, ids[1]);
  assert.equal(s.todos.length, 2);
  assert.deepEqual(
    s.todos.map((t) => t.id),
    [ids[0], ids[2]],
  );
  assert.deepEqual(
    s.todos.map((t) => t.title),
    ['a', 'c'],
  );
});

// R06 -----------------------------------------------------------------------
test('R06: filters and counts stay consistent with current data', () => {
  let s = freshStore();
  s = createTodo(s, 'a'); // active
  s = createTodo(s, 'b'); // will be completed
  s = createTodo(s, 'c'); // active
  const [, idB] = s.todos.map((t) => t.id);
  s = toggleTodo(s, idB);

  assert.deepEqual(counts(s), { total: 3, active: 2, completed: 1 });

  s = setFilter(s, 'all');
  assert.equal(filterTodos(s).length, 3);

  s = setFilter(s, 'active');
  assert.equal(filterTodos(s).length, 2);
  assert.equal(filterTodos(s).every((t) => !t.completed), true);

  s = setFilter(s, 'completed');
  assert.equal(filterTodos(s).length, 1);
  assert.equal(filterTodos(s).every((t) => t.completed), true);

  // counts are independent of the active filter
  assert.deepEqual(counts(s), { total: 3, active: 2, completed: 1 });
});

test('R06: invalid filter value is ignored', () => {
  let s = freshStore();
  s = setFilter(s, 'all');
  const before = s.filter;
  s = setFilter(s, 'banana');
  assert.equal(s.filter, before);
});

// R08 -----------------------------------------------------------------------
test('R08: model is usable under node with no DOM (structural)', () => {
  // This test file imports only todo-model.mjs and runs under node --test,
  // proving the model has no browser/network dependency.
  let s = freshStore();
  s = createTodo(s, 'x');
  assert.ok(s.todos[0].id);
});

// R09 — critical journey ----------------------------------------------------
test('R09 critical journey: add x2 -> complete -> filter completed -> edit -> delete', () => {
  let s = freshStore();

  // 1. add two
  s = createTodo(s, '学习');
  s = createTodo(s, '运动');
  assert.equal(s.todos.length, 2);
  const [idStudy, idSport] = s.todos.map((t) => t.id);

  // 2. complete one (运动)
  s = toggleTodo(s, idSport);
  assert.equal(s.todos.find((t) => t.id === idSport).completed, true);
  assert.equal(s.todos.find((t) => t.id === idStudy).completed, false);

  // 3. filter completed
  s = setFilter(s, 'completed');
  const completedView = filterTodos(s);
  assert.equal(completedView.length, 1);
  assert.equal(completedView[0].id, idSport);

  // counts consistent with current data regardless of filter
  assert.deepEqual(counts(s), { total: 2, active: 1, completed: 1 });

  // 4. edit the other (学习) — blank must not destroy it
  s = editTodo(s, idStudy, '   ');
  assert.equal(s.todos.find((t) => t.id === idStudy).title, '学习');
  s = editTodo(s, idStudy, '深入学习');
  assert.equal(s.todos.find((t) => t.id === idStudy).title, '深入学习');
  assert.equal(s.todos.find((t) => t.id === idStudy).id, idStudy); // id stable

  // 5. delete target (运动); the other item (学习) is unaffected
  s = deleteTodo(s, idSport);
  assert.equal(s.todos.length, 1);
  assert.equal(s.todos[0].id, idStudy);
  assert.equal(s.todos[0].title, '深入学习');
  assert.equal(s.todos[0].completed, false);

  // remaining data reflected in counts
  assert.deepEqual(counts(s), { total: 1, active: 1, completed: 0 });
});
