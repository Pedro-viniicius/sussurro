// Um import por ícone: o Metro não faz tree-shaking, e o índice do Lucide traria ~1.900 ícones.
// align-left e trash-2 são apelidos no Lucide 1.x: os arquivos são text-align-start e trash.
import type { LucideIcon } from 'lucide-react-native';
import Bluetooth from 'lucide-react-native/icons/bluetooth';
import BluetoothOff from 'lucide-react-native/icons/bluetooth-off';
import Camera from 'lucide-react-native/icons/camera';
import Check from 'lucide-react-native/icons/check';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleX from 'lucide-react-native/icons/circle-x';
import Clock from 'lucide-react-native/icons/clock';
import Copy from 'lucide-react-native/icons/copy';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import Eye from 'lucide-react-native/icons/eye';
import EyeOff from 'lucide-react-native/icons/eye-off';
import Grid3x3 from 'lucide-react-native/icons/grid-3x3';
import Heart from 'lucide-react-native/icons/heart';
import House from 'lucide-react-native/icons/house';
import Image from 'lucide-react-native/icons/image';
import ImageOff from 'lucide-react-native/icons/image-off';
import ImagePlus from 'lucide-react-native/icons/image-plus';
import Lock from 'lucide-react-native/icons/lock';
import LogOut from 'lucide-react-native/icons/log-out';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import Pause from 'lucide-react-native/icons/pause';
import Play from 'lucide-react-native/icons/play';
import QrCode from 'lucide-react-native/icons/qr-code';
import Radio from 'lucide-react-native/icons/radio';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import RotateCcw from 'lucide-react-native/icons/rotate-ccw';
import ScanLine from 'lucide-react-native/icons/scan-line';
import Search from 'lucide-react-native/icons/search';
import SmartphoneNfc from 'lucide-react-native/icons/smartphone-nfc';
import SquarePlay from 'lucide-react-native/icons/square-play';
import SquarePlus from 'lucide-react-native/icons/square-plus';
import AlignLeft from 'lucide-react-native/icons/text-align-start';
import Trash2 from 'lucide-react-native/icons/trash';
import Video from 'lucide-react-native/icons/video';
import Volume2 from 'lucide-react-native/icons/volume-2';
import VolumeX from 'lucide-react-native/icons/volume-x';
import WifiOff from 'lucide-react-native/icons/wifi-off';
import X from 'lucide-react-native/icons/x';
import { View } from 'react-native';

import { HouseFill } from '../../icons/HouseFill';
import { type ColorToken, theme } from '../../theme';

/** Ícones do Lucide usados no app (ux.md §6.11), pelo nome em kebab-case do Lucide. */
const lucideIcons = {
  'align-left': AlignLeft,
  bluetooth: Bluetooth,
  'bluetooth-off': BluetoothOff,
  camera: Camera,
  check: Check,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'circle-alert': CircleAlert,
  'circle-x': CircleX,
  clock: Clock,
  copy: Copy,
  ellipsis: Ellipsis,
  eye: Eye,
  'eye-off': EyeOff,
  'grid-3x3': Grid3x3,
  heart: Heart,
  house: House,
  image: Image,
  'image-off': ImageOff,
  'image-plus': ImagePlus,
  lock: Lock,
  'log-out': LogOut,
  'message-circle': MessageCircle,
  pause: Pause,
  play: Play,
  'qr-code': QrCode,
  radio: Radio,
  'refresh-cw': RefreshCw,
  'rotate-ccw': RotateCcw,
  'scan-line': ScanLine,
  search: Search,
  'smartphone-nfc': SmartphoneNfc,
  'square-play': SquarePlay,
  'square-plus': SquarePlus,
  'trash-2': Trash2,
  video: Video,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  'wifi-off': WifiOff,
  x: X,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof lucideIcons | 'house-fill';

export const iconNames = [...Object.keys(lucideIcons), 'house-fill'] as IconName[];

export interface IconProps {
  name: IconName;
  /** 24 padrão; 20 em ações do texto; 28 no visualizador; 16 em linha (ux.md §6.8). */
  size?: number;
  color?: ColorToken;
  /** Ativo "mais grosso": traço 2,75. Em `house`, troca pelo `house-fill`. */
  active?: boolean;
  /** Preenche o desenho com a cor (ex.: coração curtido). */
  filled?: boolean;
  /** Sem rótulo, o ícone é decorativo e some do leitor de tela. */
  accessibilityLabel?: string;
  testID?: string;
}

export function Icon({
  name,
  size = theme.size.icon.md,
  color = 'black',
  active = false,
  filled = false,
  accessibilityLabel,
  testID,
}: IconProps) {
  const hex = theme.colors[color];
  const strokeWidth = active ? theme.size.iconStroke.active : theme.size.iconStroke.regular;
  const resolved: IconName = name === 'house' && active ? 'house-fill' : name;

  const glyph =
    resolved === 'house-fill' ? (
      <HouseFill size={size} color={hex} />
    ) : (
      (() => {
        const LucideGlyph = lucideIcons[resolved];
        return (
          <LucideGlyph
            size={size}
            color={hex}
            strokeWidth={strokeWidth}
            fill={filled ? hex : 'none'}
          />
        );
      })()
    );

  const decorative = accessibilityLabel === undefined;
  return (
    <View
      testID={testID ?? `icon-${resolved}`}
      accessible={!decorative}
      {...(decorative
        ? {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
          }
        : { accessibilityRole: 'image' as const, accessibilityLabel })}
    >
      {glyph}
    </View>
  );
}
