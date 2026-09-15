export const minimumSeedParagraphs = 5;

export type SeedEditorialNote = {
  title: string;
  excerpt: string;
  tags: string[];
  paragraphs: string[];
};

export type SeedLocale = 'es' | 'en' | 'ru';

function spanishContinuations(note: SeedEditorialNote) {
  const themes = note.tags.join(', ');
  return [
    `A partir de «${note.excerpt}», ${note.title.toLowerCase()} se presenta como una práctica situada: una experiencia hecha de decisiones compartidas, conflictos concretos y aprendizajes que sólo aparecen cuando la organización se sostiene en el tiempo.`,
    `Las voces reunidas en esta nota no buscan una receta universal. Describen acuerdos, errores y formas de cooperación que cambian según el barrio, los recursos disponibles y las personas que deciden involucrarse.`,
    `Los temas de ${themes} atraviesan el relato sin quedar reducidos a consignas. Cada uno obliga a preguntar quién toma las decisiones, cómo se distribuye el trabajo y qué herramientas permiten cuidar lo construido en común.`,
    `La memoria de experiencias anteriores funciona como una orientación, no como un molde. Recuperar esas huellas permite reconocer continuidades, revisar límites y evitar que cada iniciativa tenga que comenzar desde cero.`,
    `El texto queda abierto porque ninguna transformación colectiva se resuelve en una conclusión. La invitación final es conversar, documentar lo aprendido y convertir la lectura en nuevos vínculos y acciones compartidas.`,
  ];
}

function englishParagraphs(title: string, excerpt: string) {
  return [
    `${title} begins with “${excerpt}” and follows it into everyday collective practice, where autonomy is built through shared decisions rather than granted by an institution.`,
    `The experiences gathered here do not offer a universal recipe. They describe agreements, mistakes, and forms of cooperation shaped by each territory and by the people willing to sustain them.`,
    `Memory, mutual aid, and material conditions remain connected throughout the article. The central question is always who decides, who performs the work, and how responsibility can be distributed without creating a new hierarchy.`,
    `Looking back is treated as a practical tool instead of nostalgia. Earlier struggles leave methods, warnings, and unfinished questions that can help present initiatives avoid starting from nothing.`,
    `The article deliberately ends without a closed conclusion. Its final invitation is to discuss, document what was learned, and turn reading into relationships and collective action.`,
  ];
}

function russianParagraphs(title: string, excerpt: string) {
  return [
    `Материал «${title}» начинается с темы «${excerpt}» и рассматривает её как повседневную коллективную практику, где автономия возникает из общих решений, а не даруется институтами.`,
    `Собранный опыт не претендует на универсальный рецепт. Он показывает договорённости, ошибки и формы сотрудничества, которые зависят от конкретного места и от людей, готовых поддерживать общее дело.`,
    `Память, взаимопомощь и материальные условия здесь неразделимы. Главные вопросы — кто принимает решения, кто выполняет работу и как распределить ответственность, не создавая новую иерархию.`,
    `Обращение к прошлому служит практическим инструментом, а не ностальгией. Предыдущие борьбы оставляют методы, предупреждения и незавершённые вопросы, помогающие не начинать каждую инициативу с нуля.`,
    `Текст намеренно не предлагает окончательного вывода. Его последняя мысль — обсуждать, сохранять приобретённый опыт и превращать чтение в новые связи и совместные действия.`,
  ];
}

export function completeSeedBody(note: SeedEditorialNote) {
  const completed = note.paragraphs.map(paragraph => paragraph.trim()).filter(Boolean);
  for (const paragraph of spanishContinuations(note)) {
    if (completed.length >= minimumSeedParagraphs) break;
    completed.push(paragraph);
  }
  return completed;
}

export function localizedSeedBody(locale: Exclude<SeedLocale, 'es'>, title: string, excerpt: string) {
  return locale === 'en' ? englishParagraphs(title, excerpt) : russianParagraphs(title, excerpt);
}

export function seedBodyMarkdown(paragraphs: string[]) {
  return paragraphs.join('\n\n');
}
