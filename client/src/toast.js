import { createContext, useContext } from 'react'

// notify(message, { type: 'success' | 'error' | 'info' }) shows a short toast message
export const ToastContext = createContext(() => {})

export function useToast() {
  return useContext(ToastContext)
}
