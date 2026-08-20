// UI binding layer. All state rules live in todo-model.mjs (R08 separation).
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
} from './todo-model.mjs';

const store = createStore({ idGenerator: createIdGenerator() });

const form = document.getElementById('new-todo-form');
const input = document.getElementById('new-todo');
const listEl = document.getElementById('todo-list');
const countsEl = document.getElementById('counts');
const emptyHint = document.getElementById('empty-hint');
const filterButtons = Array.from(document.querySelectorAll('.filters button'));
const itemTemplate = document.getElementById('todo-item-template');

// ---- wiring --------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  // R01: blank input is rejected by the model; clear only when accepted.
  const before = store.todos.length;
  Object.assign(store, createTodo(store, input.value));
  if (store.todos.length > before) {
    input.value = '';
  }
  input.focus();
  render();
});

filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    // R06: switch the view to the clicked filter (all / active / completed).
    Object.assign(store, setFilter(store, btn.dataset.filter));
    render();
  });
});

listEl.addEventListener('click', (event) => {
  const li = event.target.closest('.todo-item');
  if (!li) return;
  const id = li.dataset.id;

  if (event.target.classList.contains('todo-toggle')) {
    Object.assign(store, toggleTodo(store, id));
    render();
  } else if (event.target.classList.contains('todo-delete')) {
    Object.assign(store, deleteTodo(store, id));
    render();
  } else if (
    event.target.classList.contains('todo-edit') ||
    event.target.classList.contains('todo-title')
  ) {
    startEdit(li, id);
  }
});

// ---- rendering -----------------------------------------------------------

function render() {
  const visible = filterTodos(store);
  listEl.innerHTML = '';
  for (const todo of visible) {
    listEl.appendChild(renderItem(todo));
  }

  emptyHint.hidden = visible.length !== 0;

  // R06: counts consistent with current data.
  const c = counts(store);
  countsEl.textContent = `共 ${c.total} 项 · 进行中 ${c.active} 项 · 已完成 ${c.completed} 项`;

  // R07: reflect active filter via aria-pressed.
  filterButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.filter === store.filter));
  });
}

function renderItem(todo) {
  const node = itemTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = todo.id;
  node.classList.toggle('completed', todo.completed);

  const checkbox = node.querySelector('.todo-toggle');
  checkbox.checked = todo.completed;
  checkbox.setAttribute(
    'aria-label',
    todo.completed
      ? `将「${todo.title}」标记为未完成`
      : `将「${todo.title}」标记为完成`,
  );

  const titleEl = node.querySelector('.todo-title');
  titleEl.textContent = todo.title;

  // R07: completion state shown as text, not color alone.
  const stateEl = node.querySelector('.todo-state');
  stateEl.textContent = todo.completed ? '（已完成）' : '（进行中）';

  const editBtn = node.querySelector('.todo-edit');
  editBtn.setAttribute('aria-label', `编辑「${todo.title}」`);
  const delBtn = node.querySelector('.todo-delete');
  delBtn.setAttribute('aria-label', `删除「${todo.title}」`);

  return node;
}

// R04: inline edit. Blank edit keeps the original title (model enforces).
function startEdit(li, id) {
  const titleEl = li.querySelector('.todo-title');
  const current = store.todos.find((t) => t.id === id);
  if (!current) return;

  const editor = document.createElement('input');
  editor.type = 'text';
  editor.value = current.title;
  editor.setAttribute('aria-label', `编辑「${current.title}」的标题`);
  editor.className = 'todo-edit-input';
  titleEl.replaceWith(editor);
  editor.focus();
  editor.select();

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    Object.assign(store, editTodo(store, id, editor.value)); // R04 blank-safe
    render();
  };

  editor.addEventListener('blur', commit);
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      editor.blur();
    } else if (event.key === 'Escape') {
      committed = true; // discard
      render();
    }
  });
}

render();
