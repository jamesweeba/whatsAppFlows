/**
 * Utility to convert raw WhatsApp Flow response payload JSON into a clean,
 * human-readable text string for chat history and AI intent classification.
 */
export function parseFlowToText(flowData: Record<string, any>): string {
  if (!flowData || Object.keys(flowData).length === 0) {
    return 'Flow Selection: (empty payload)';
  }

  const parts: string[] = [];

  // Check common WhatsApp Flow response fields
  if (flowData.screen || flowData.flow_screen) {
    parts.push(`Screen: ${flowData.screen || flowData.flow_screen}`);
  }

  if (flowData.action) {
    parts.push(`Action: ${flowData.action}`);
  }

  if (flowData.selected_product || flowData.product_name || flowData.product_id) {
    const name = flowData.product_name || flowData.selected_product || flowData.product_id;
    const qty = flowData.quantity || flowData.qty || 1;
    parts.push(`Selected Product: "${name}" (Qty: ${qty})`);
  }

  if (flowData.items && Array.isArray(flowData.items)) {
    const itemsFormatted = flowData.items
      .map((item: any) => `${item.name || item.id || 'Item'} (x${item.quantity || 1})`)
      .join(', ');
    parts.push(`Items: [${itemsFormatted}]`);
  }

  // Format any remaining key-values
  const handledKeys = new Set(['screen', 'flow_screen', 'action', 'selected_product', 'product_name', 'product_id', 'quantity', 'qty', 'items']);
  const customEntries: string[] = [];

  for (const [key, value] of Object.entries(flowData)) {
    if (!handledKeys.has(key)) {
      customEntries.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
  }

  if (customEntries.length > 0) {
    parts.push(customEntries.join(', '));
  }

  return `Flow Selection: ${parts.join(' | ')}`;
}
