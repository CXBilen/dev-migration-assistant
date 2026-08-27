import { Eye, EyeOff } from 'lucide-react'
import { forwardRef, useState } from 'react'
import { Button } from './button'
import { TextField, type TextFieldProps } from './text-field'

export type PasswordFieldProps = Omit<TextFieldProps, 'type' | 'trailing'>

/** Password input with a show/hide toggle. Never autocompleted or spell-checked. */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField(props, ref) {
    const [visible, setVisible] = useState(false)
    return (
      <TextField
        ref={ref}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        trailing={
          <Button
            variant="ghost"
            size="sm"
            className="size-8 px-0 text-fg-muted"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
          >
            {visible ? (
              <EyeOff className="size-4" aria-hidden />
            ) : (
              <Eye className="size-4" aria-hidden />
            )}
          </Button>
        }
        {...props}
      />
    )
  },
)
