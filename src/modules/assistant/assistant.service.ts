import type { PublicLocale } from '../content/localization.js';

export type AssistantIntent = 'greeting' | 'archive' | 'contribute' | 'help' | 'default';

const intents: Array<{ intent: Exclude<AssistantIntent, 'default'>; pattern: RegExp }> = [
  { intent: 'greeting', pattern: /(?:^|[^\p{L}\p{N}])(?:hola|buenas|hello|hi|привет|здравствуй)(?=$|[^\p{L}\p{N}])/iu },
  { intent: 'archive', pattern: /(?:^|[^\p{L}\p{N}])(?:archivo|edici[oó]n|nota|archive|issue|article|архив|выпуск|статья)(?=$|[^\p{L}\p{N}])/iu },
  { intent: 'contribute', pattern: /(?:^|[^\p{L}\p{N}])(?:colaborar|colaboraci[oó]n|donar|aporte|contribute|contribution|donate|сотрудничать|пожертвование)(?=$|[^\p{L}\p{N}])/iu },
  { intent: 'help', pattern: /(?:^|[^\p{L}\p{N}])(?:ayuda|c[oó]mo|help|how|помощь|как)(?=$|[^\p{L}\p{N}])/iu },
];

const replies: Record<PublicLocale, Record<AssistantIntent, string>> = {
  es: {
    greeting: 'Hola. Soy el asistente simulado de La Guillotina. Puedo orientarte por el archivo, las notas y las formas de colaborar.',
    archive: 'Podés recorrer las ediciones desde el Archivo y abrir cada nota desde su portada. La edición publicada más reciente aparece primero.',
    contribute: 'Para colaborar, abrí la sección Colaborar. Allí vas a encontrar las vías editoriales y de apoyo disponibles.',
    help: 'Puedo ayudarte a encontrar ediciones, notas, recursos o información para colaborar. Decime qué estás buscando.',
    default: 'Recibí tu mensaje. Esta es una respuesta simulada: puedo orientarte sobre el archivo, las notas y las formas de colaborar.',
  },
  en: {
    greeting: 'Hello. I am La Guillotina’s simulated assistant. I can guide you through the archive, articles, and ways to contribute.',
    archive: 'Browse published issues in the Archive and open each article from its cover. The latest published issue appears first.',
    contribute: 'Open the Contribute section to find the available editorial and support channels.',
    help: 'I can help you find issues, articles, resources, or contribution information. Tell me what you are looking for.',
    default: 'I received your message. This is a simulated reply: I can guide you through the archive, articles, and ways to contribute.',
  },
  ru: {
    greeting: 'Привет. Я имитация помощника «Гильотины». Я помогу найти архив, материалы и способы участия.',
    archive: 'Опубликованные выпуски находятся в Архиве, а материалы открываются с их обложек. Сначала показан самый новый выпуск.',
    contribute: 'Откройте раздел «Участвовать», чтобы узнать о доступных способах прислать материал или поддержать проект.',
    help: 'Я помогу найти выпуски, материалы, ресурсы или информацию об участии. Напишите, что вы ищете.',
    default: 'Сообщение получено. Это имитация ответа: я могу помочь с архивом, материалами и способами участия.',
  },
};

export function classifyAssistantMessage(message: string): AssistantIntent {
  const normalized = message.normalize('NFKC').toLocaleLowerCase();
  return intents.find(candidate => candidate.pattern.test(normalized))?.intent ?? 'default';
}

export function simulateAssistantReply(message: string, locale: PublicLocale) {
  return replies[locale][classifyAssistantMessage(message)];
}
