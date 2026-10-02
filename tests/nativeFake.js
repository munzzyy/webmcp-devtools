// tests/nativeFake.js
//
// Chromium 153's native shape: fresh tool objects from every getTools(), a string inputSchema, a
// `window` per tool, names unique per window only, an executeTool that takes a JSON string, and
// toolchange fired from a later task, so an abort and a re-register in one task both list the result.
export function nativeModelContext(ownWindow) {
  const entries = []; // { window, name, description, inputSchema, execute, runs }
  const listeners = [];
  const changed = () => setImmediate(() => { for (const fn of listeners) fn(); });
  const unknownError = (message) => Object.assign(new Error(message), { name: 'UnknownError' });
  const mc = {
    entries,
    addEventListener(type, fn) {
      if (type === 'toolchange') listeners.push(fn);
    },
    async registerTool(descriptor, options = {}) {
      const win = descriptor.window || ownWindow;
      if (entries.some((e) => e.window === win && e.name === descriptor.name)) {
        throw Object.assign(new Error('Duplicate tool name'), { name: 'InvalidStateError' });
      }
      const entry = {
        window: win,
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        execute: descriptor.execute,
        runs: 0,
      };
      entries.push(entry);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          entries.splice(entries.indexOf(entry), 1);
          changed();
        });
      }
      changed();
    },
    async getTools() {
      return entries.map((e) => ({
        name: e.name,
        title: '',
        description: e.description,
        inputSchema: JSON.stringify(e.inputSchema),
        origin: 'https://page.example',
        window: e.window,
      }));
    },
    async executeTool(tool, args) {
      if (typeof args !== 'string') throw unknownError('Failed to parse input arguments');
      const entry = entries.find((e) => e.window === tool.window && e.name === tool.name);
      if (!entry) throw unknownError('Tool not found');
      entry.runs += 1;
      try {
        return JSON.stringify(await entry.execute(JSON.parse(args)));
      } catch (err) {
        throw unknownError('Tool was executed but the invocation failed');
      }
    },
  };
  return mc;
}

export const nativeTool = (name, extra = {}) => ({
  name,
  description: `The ${name} tool.`,
  inputSchema: { type: 'object', properties: {} },
  execute: async (args) => ({ ran: name, args }),
  ...extra,
});
