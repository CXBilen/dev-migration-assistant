import '@testing-library/jest-dom/vitest'
import '../test/setup'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WarningList } from './warning-list'

describe('WarningList', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<WarningList warnings={[]} testId="w" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders every warning with a warning glyph inside a live region', () => {
    render(<WarningList warnings={['first', 'second', 'first']} testId="w" />)
    const list = screen.getByTestId('w')
    expect(list).toHaveAttribute('role', 'status')
    expect(list.querySelectorAll('li')).toHaveLength(3)
    expect(screen.getAllByRole('img', { name: 'Warning' })).toHaveLength(3)
    expect(list).toHaveTextContent('first')
    expect(list).toHaveTextContent('second')
  })
})
