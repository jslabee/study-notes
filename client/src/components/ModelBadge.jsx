// Shows which provider and model produced notes or an answer, as "<provider>:<model>"
function ModelBadge({ value }) {
  if (!value) return null
  return (
    <span className="badge badge-model" title="Provider and model used">
      {value}
    </span>
  )
}

export default ModelBadge
