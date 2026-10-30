import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AccessibilityInfo, Animated, Platform, StyleSheet } from 'react-native';

import { Toast, type ToastAction, type ToastVariant } from './Toast';
import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';

export interface ShowToastOptions {
  message: string;
  variant?: ToastVariant;
  action?: ToastAction;
  /** Em ms. Padrão: 4 s, ou 6 s com ação (ux.md §6.10). */
  duration?: number;
}

interface QueuedToast extends ShowToastOptions {
  id: number;
}

interface ToastContextValue {
  show: (options: ShowToastOptions) => void;
  hide: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps {
  children: ReactNode;
  /** Distância do rodapé (acima da tab bar ou do safe area). */
  bottomOffset?: number;
}

/** Um Toast por vez, em fila. Use `useToast()` para mostrar. */
export function ToastProvider({ children, bottomOffset = theme.space[12] }: ToastProviderProps) {
  const reduceMotion = useReducedMotion();
  const [queue, setQueue] = useState<QueuedToast[]>([]);
  const nextId = useRef(1);
  const [opacity] = useState(() => new Animated.Value(0));
  const current = queue[0];

  const hide = useCallback(() => {
    setQueue((items) => items.slice(1));
  }, []);

  const show = useCallback((options: ShowToastOptions) => {
    const id = nextId.current++;
    setQueue((items) => [...items, { ...options, id }]);
  }, []);

  useEffect(() => {
    if (current === undefined) {
      return undefined;
    }
    opacity.setValue(0);
    Animated.timing(opacity, {
      toValue: 1,
      duration: reduceMotion ? 0 : theme.motion.slow,
      useNativeDriver: true,
    }).start();
    if (Platform.OS === 'ios') {
      // No Android o accessibilityLiveRegion do Toast já faz o anúncio.
      AccessibilityInfo.announceForAccessibility(current.message);
    }
    const duration =
      current.duration ??
      (current.action === undefined
        ? theme.motion.toastVisible
        : theme.motion.toastVisibleWithAction);
    const timer = setTimeout(hide, duration);
    return () => {
      clearTimeout(timer);
    };
  }, [current, hide, opacity, reduceMotion]);

  const value = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {current === undefined ? null : (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.host, { bottom: bottomOffset, opacity }]}
        >
          <Toast
            key={current.id}
            message={current.message}
            {...(current.variant === undefined ? {} : { variant: current.variant })}
            {...(current.action === undefined
              ? {}
              : {
                  action: {
                    label: current.action.label,
                    onPress: () => {
                      current.action?.onPress();
                      hide();
                    },
                  },
                })}
          />
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast precisa de um <ToastProvider> acima na árvore.');
  }
  return context;
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: theme.space[16],
    right: theme.space[16],
  },
});
