export interface SelectionRefSpec {
  kind: 'row-field'
  field: string
}

export type SelectionRefValue = string | number | boolean | null

export interface SelectionRef {
  field: string
  value: SelectionRefValue
}

export interface SelectionPayload {
  selectedRefs: SelectionRef[]
}
