export const mediaImages = {
  rally: ['photo-1529107386315-e1a2ed48a620', 'Personas levantando carteles en una movilización', 'Las calles también son archivo.'],
  workshop: ['photo-1517048676732-d65bc937f952', 'Personas reunidas alrededor de una mesa de trabajo', 'Una mesa compartida para pensar en común.'],
  poster: ['photo-1514525253161-7a46d19cd819', 'Mural y carteles en una pared urbana', 'Gráfica que ocupa la pared.'],
  crowd: ['photo-1531058020387-3be344556be6', 'Multitud vista desde el frente', 'Muchas voces, ninguna sola.'],
  hands: ['photo-1529156069898-49953e39b3ac', 'Manos alzadas durante una reunión', 'La asamblea empieza por escuchar.'],
  street: ['photo-1500534623283-312aade485b7', 'Calle y edificios vistos desde abajo', 'El barrio como punto de partida.'],
  print: ['photo-1503602642458-232111445657', 'Mesa con papel y herramientas de trabajo', 'Hacer circular también es imprimir.'],
  archive: ['photo-1491841550275-ad7854e35ca6', 'Cuadernos y papeles abiertos sobre una mesa', 'Todo archivo está vivo si se usa.'],
  nature: ['photo-1497250681960-ef046c08a56e', 'Plantas creciendo entre la luz', 'Cuidar la vida no admite jerarquías.'],
  paint: ['photo-1549490349-8643362247b5', 'Pared pintada y texturas de color', 'La ciudad deja marcas y las leemos.'],
  camera: ['photo-1485846234645-a62644f84728', 'Cámara de cine antigua sobre un soporte', 'Una cámara también puede tomar partido.'],
  table: ['photo-1517245386807-bb43f82c33c4', 'Mesa colectiva con cuadernos y sillas', 'Organizarse es hacer lugar.'],
  blackCat: ['photo-1636202333095-44068f90fe34', 'Gato negro mirando de frente sobre un fondo neutro', 'Un símbolo que aparece sin pedir permiso.'],
} as const;

export type SeedMediaKey = keyof typeof mediaImages;

export const noteMedia = {
  cat: ['blackCat', 'street'],
  freedom: ['hands', 'workshop'],
  uprising: ['rally', 'crowd'],
  wall: ['paint', 'poster'],
  why: ['table', 'workshop'],
  memory: ['camera', 'archive'],
  contents: ['print', 'poster'],
  quote: ['nature', 'street'],
  kitchens: ['workshop', 'table', 'hands'],
  posters: ['poster', 'paint', 'print', 'street'],
  seeds: ['nature', 'street'],
  'street-choir': ['crowd', 'rally', 'hands'],
  care: ['hands', 'workshop', 'table'],
  press: ['print', 'archive', 'poster'],
  'living-archive': ['archive', 'print', 'poster', 'table', 'camera'],
  'affection-map': ['street', 'rally', 'workshop'],
} as const satisfies Record<string, readonly SeedMediaKey[]>;

export function seedImageUrl(key: SeedMediaKey) {
  return `https://images.unsplash.com/${mediaImages[key][0]}?auto=format&fit=crop&w=1400&q=85`;
}
