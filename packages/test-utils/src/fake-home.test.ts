import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeHome } from './fake-home'
import { withTempRoot } from './temp'

describe('createFakeHome', () => {
  it('creates <root>/Users/<user> with .claude and Documents/GitHub and a matching env', async () => {
    await withTempRoot(async (root) => {
      const home = await createFakeHome(root, { userName: 'alice' })
      expect(home.homeDir).toBe(path.join(root, 'Users', 'alice'))
      expect(home.claudeConfigDir).toBe(path.join(home.homeDir, '.claude'))
      expect(home.claudeJsonPath).toBe(path.join(home.homeDir, '.claude.json'))
      expect(home.projectsDir).toBe(path.join(home.homeDir, 'Documents', 'GitHub'))
      for (const dir of [home.homeDir, home.claudeConfigDir, home.projectsDir]) {
        expect((await fs.stat(dir)).isDirectory()).toBe(true)
      }
      expect(await fs.readdir(home.claudeConfigDir)).toEqual([])
      expect(home.env.HOME).toBe(home.homeDir)
      expect(home.env.USER).toBe('alice')
      expect('CLAUDE_CONFIG_DIR' in home.env).toBe(true)
      expect(home.env.CLAUDE_CONFIG_DIR).toBeUndefined()
      // ~/.claude.json is not created: the Claude fixture writes it.
      await expect(fs.stat(home.claudeJsonPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('defaults to alice and rejects unsafe user names', async () => {
    await withTempRoot(async (root) => {
      const home = await createFakeHome(root)
      expect(home.userName).toBe('alice')
      await expect(createFakeHome(root, { userName: '../bob' })).rejects.toThrow()
      await expect(createFakeHome(root, { userName: '' })).rejects.toThrow()
    })
  })

  it('supports two users side by side under one root', async () => {
    await withTempRoot(async (root) => {
      const a = await createFakeHome(root, { userName: 'alice' })
      const b = await createFakeHome(root, { userName: 'bob' })
      expect(a.homeDir).not.toBe(b.homeDir)
      expect(path.dirname(a.homeDir)).toBe(path.dirname(b.homeDir))
    })
  })
})
