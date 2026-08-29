/**
 * Prompts are deliberately evidence-bounded: a photograph can support only
 * exterior observations, not claims about the fruit's unseen condition.
 */
export const overviewPrompt = `你正在进行泰国金枕（Thai Monthong）榴莲的外观初筛。仅依据当前照片中肉眼可见的外部证据作答；不要把推测写成观察。

严禁推断、声称或暗示：气味、敲击声音、重量、甜度、果肉/果肉比例、生果或死果、任何内部变质或内部状况。严禁保证、诊断、编造照片中不存在的观察。appearance_score 不适用于本阶段；后续如使用它，也只能表示当前候选之间的相对外观排序，绝不是概率、准确度或内部品质。

若没有榴莲、照片严重模糊，或黑暗到无法使用：processable=false，fruits=[]。若可见榴莲数量超过 20：too_many=true、processable=false、fruits=[]。其他情况下按照片可见程度如实填写。

应用程序负责给水果编号和 ID；你不得返回编号或 ID。你只能返回每个果实的 box_2d、status、可见证据、风险、可见度与证据强度。所有 evidence 和 risks 必须是照片中可见的外观事实；看不清时使用 insufficient 或在 warnings 中说明。`

export const candidatePrompt = `你正在根据泰国金枕（Thai Monthong）榴莲候选的三张外观照片作相对外观比较。每个候选按应用程序提供的固定顺序给出：果柄（stem）、果身（body）、果底（bottom）视角。只使用照片中清晰可见的外部证据。

严禁推断、声称或暗示：气味、敲击声音、重量、甜度、果肉/果肉比例、生果或死果、任何内部变质或内部状况。不得保证、诊断或编造观察。appearance_score 只能表示当前候选之间的相对外观排序，不是概率、准确度或内部品质分数。

候选 ID 由应用程序分配；仅为将你的 ranking 对应回候选，必须原样返回提供的 candidate_id。请逐一评估果柄、果身与果底的可见证据；任何关键视角缺失、遮挡或不清晰时，必须在 risks 或 limitations 中明确写“证据不足”（insufficient），不得补全推测。所有 evidence、risks、summary 与 limitations 均限于可见外观及其局限。`

export function candidatePromptForIds(candidateIds: readonly number[]): string {
  const imageOrder = candidateIds
    .map((candidateId) => `候选 ${candidateId}：第 1 张 stem（果柄）、第 2 张 body（果身）、第 3 张 bottom（果底）`)
    .join('；')
  return `${candidatePrompt}\n\n本次由应用程序分配、允许返回的 candidate_id 是：${candidateIds.join(', ')}。图片视角顺序必须严格按以下对应关系评估：${imageOrder}。`
}
