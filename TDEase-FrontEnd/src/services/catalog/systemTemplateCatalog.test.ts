import { describe, expect, it, vi } from 'vitest'
import { createSystemTemplateCatalog } from './systemTemplateCatalog'

describe('SystemTemplateCatalog', () => {
  it('lists and reads templates exclusively through Client System assets', async () => {
    const content: Record<string, string> = {
      'templates/example/template.json': JSON.stringify({
        id: 'example', version: '1', name: 'Example', description: 'Local reference', nodes: ['tool-a'],
      }),
      'templates/example/Snakefile': 'rule all:\n    input: []\n',
      'templates/example/config.yaml': 'value: 1\n',
    }
    const bridge = {
      listFiles: vi.fn().mockResolvedValue(['example/Snakefile', 'example/config.yaml', 'example/template.json']),
      readText: vi.fn(async (path: string) => content[path]!),
    }
    const catalog = createSystemTemplateCatalog(bridge)

    await expect(catalog.list()).resolves.toMatchObject([{
      id: 'example', version: '1', name: 'Example', nodes: ['tool-a'],
    }])
    await expect(catalog.get('example')).resolves.toMatchObject({
      id: 'example',
      files: { Snakefile: 'rule all:\n    input: []\n', 'config.yaml': 'value: 1\n' },
    })
    expect(bridge.listFiles).toHaveBeenCalledWith('templates')
    expect(bridge.readText).toHaveBeenCalledWith('templates/example/template.json')
  })

  it('rejects template path injection before reading Client files', async () => {
    const bridge = { listFiles: vi.fn(), readText: vi.fn() }
    await expect(createSystemTemplateCatalog(bridge).get('../secret')).rejects.toThrow('Invalid template id')
    expect(bridge.readText).not.toHaveBeenCalled()
  })
})
