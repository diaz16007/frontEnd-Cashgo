import type { KeyboardEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  RetailProductCreateWorkspace,
  type RetailProductCreateWorkspaceTab,
} from '@/modules/inventory/components/RetailProductCreateWorkspace'
import {
  useProductsQuery,
  useUpdateProductMutation,
} from '@/modules/products/hooks/use-products-query'
import { matchesProductSearch } from '@/modules/products/utils/matches-product-search'
import {
  useCreateInventoryCategoryMutation,
  useDeleteInventoryCategoryMutation,
  useInventoryCategoriesQuery,
  useInventoryLowStockQuery,
  useCreateInventoryAdjustmentMutation,
  useRegisterInventoryPurchaseMutation,
  useUpdateInventoryCategoryMutation,
  useUpdateInventoryProductTaxesMutation,
} from '@/modules/inventory/hooks/use-inventory-query'
import { getInventoryCopy } from '@/modules/inventory/i18n/inventory-copy'
import { exportInventoryReport } from '@/modules/inventory/services/inventory-api'
import { inventoryTaxOptions } from '@/modules/inventory/constants/inventory-tax-options'
import type {
  InventoryAdjustmentInput,
  InventoryProductCategory,
  InventoryProductCategoryInput,
  ManualInventoryAdjustmentType,
} from '@/modules/inventory/types/inventory'
import type {
  Product,
  ProductMutationInput,
} from '@/modules/products/types/product'
import { resolveProductImageUrl } from '@/modules/products/utils/resolve-product-image-url'
import {
  useBusinessSettingsQuery,
  useUpdateBusinessSettingsMutation,
} from '@/modules/settings/hooks/use-settings-query'
import { buildConfiguredCatalogUrl } from '@/modules/settings/utils/virtual-catalog'
import { routePaths, routeSegments } from '@/routes/route-paths'
import { useAppTranslation } from '@/shared/i18n/use-app-translation'
import retailStyles from '@/shared/components/retail/RetailUI.module.css'
import { RetailEmptyState } from '@/shared/components/retail/RetailEmptyState'
import { RetailPageLayout } from '@/shared/components/retail/RetailPageLayout'
import { ModalShell } from '@/shared/components/ui/ModalShell'
import { SideDrawer } from '@/shared/components/ui/SideDrawer'
import { downloadBlobFile } from '@/shared/utils/download-blob-file'
import { formatCurrency } from '@/shared/utils/format-currency'
import { getErrorMessage } from '@/shared/utils/get-error-message'
import styles from './RetailInventoryWorkspace.module.css'

type InventoryFilter = 'ALL' | 'LOW'
type InventorySort = 'STOCK_ASC' | 'STOCK_DESC'

type FeedbackTone = 'success' | 'info' | 'error'

type FeedbackMessage = {
  tone: FeedbackTone
  text: string
}

type InlineProductField = 'price' | 'cost' | 'stock'

type InlineProductDraft = Record<InlineProductField, string>

type InlineProductDrafts = Record<string, InlineProductDraft>

type CategoryEditorState = {
  id: string | null
  name: string
  isVisibleInCatalog: boolean
  productIds: string[]
}

type PurchaseFormState = {
  productId: string
  quantity: string
  unitCost: string
  reason: string
}

type AdjustmentFormState = {
  productId: string
  type: ManualInventoryAdjustmentType
  quantity: string
  reason: string
}

type TaxFormState = {
  selectedOptionId: string
  productIds: string[]
}

type DrawerShellProps = {
  title: string
  titleAccessory?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

type IconButtonProps = {
  label: string
  tooltip: string
  onClick: () => void
  children: ReactNode
}

function createDefaultCategoryEditorState(): CategoryEditorState {
  return {
    id: null,
    name: '',
    isVisibleInCatalog: true,
    productIds: [],
  }
}

function createDefaultPurchaseFormState(): PurchaseFormState {
  return {
    productId: '',
    quantity: '',
    unitCost: '',
    reason: '',
  }
}

function createDefaultAdjustmentFormState(): AdjustmentFormState {
  return {
    productId: '',
    type: 'OUT',
    quantity: '1',
    reason: '',
  }
}

function createDefaultTaxFormState(): TaxFormState {
  return {
    selectedOptionId: '',
    productIds: [],
  }
}

function normalizeOptionalText(value: string) {
  const trimmedValue = value.trim()

  return trimmedValue.length > 0 ? trimmedValue : undefined
}

function parsePositiveNumber(value: string) {
  const normalizedValue = value.replace(',', '.')
  const parsedValue = Number(normalizedValue)

  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : 0
}

function parseNonNegativeNumber(value: string) {
  const normalizedValue = value.replace(',', '.')
  const parsedValue = Number(normalizedValue)

  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : -1
}

function formatEditableNumber(value: number) {
  const roundedValue = Math.round((value + Number.EPSILON) * 100) / 100

  return Number.isInteger(roundedValue)
    ? roundedValue.toString()
    : roundedValue.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function parseEditableDecimal(value: string) {
  const cleanedValue = value.trim().replace(/\$/g, '').replace(/\s/g, '')

  if (cleanedValue.length === 0) {
    return Number.NaN
  }

  const hasComma = cleanedValue.includes(',')
  const hasDot = cleanedValue.includes('.')
  const lastCommaIndex = cleanedValue.lastIndexOf(',')
  const lastDotIndex = cleanedValue.lastIndexOf('.')
  let normalizedValue = cleanedValue

  if (hasComma && hasDot) {
    normalizedValue =
      lastCommaIndex > lastDotIndex
        ? cleanedValue.replace(/\./g, '').replace(',', '.')
        : cleanedValue.replace(/,/g, '')
  } else if (hasComma) {
    normalizedValue = cleanedValue.replace(',', '.')
  } else if (hasDot) {
    const decimalSegment = cleanedValue.slice(lastDotIndex + 1)
    const dotSegments = cleanedValue.split('.')
    const looksLikeThousands =
      dotSegments.length > 1 &&
      decimalSegment.length === 3 &&
      dotSegments.slice(1).every((segment) => segment.length === 3)

    normalizedValue = looksLikeThousands
      ? cleanedValue.replace(/\./g, '')
      : cleanedValue
  }

  const parsedValue = Number(normalizedValue)

  return Number.isFinite(parsedValue) && parsedValue >= 0
    ? parsedValue
    : Number.NaN
}

function parseEditableStock(value: string) {
  const parsedValue = parseEditableDecimal(value)

  return Number.isFinite(parsedValue) ? Math.floor(parsedValue) : Number.NaN
}

function createInlineProductDraft(product: Product): InlineProductDraft {
  return {
    price: formatEditableNumber(product.price),
    cost: formatEditableNumber(product.cost),
    stock: product.stock.toString(),
  }
}

function createProductUpdateInput(
  product: Product,
  overrides: Partial<Pick<ProductMutationInput, InlineProductField>>,
): ProductMutationInput {
  return {
    barcode: product.barcode ?? undefined,
    categoryId: product.categoryId,
    cost: product.cost,
    description: product.description ?? undefined,
    isActive: product.isActive,
    isVisibleInCatalog: product.isVisibleInCatalog,
    minStock: product.minStock,
    name: product.name,
    price: product.price,
    sku: product.sku ?? undefined,
    stock: product.stock,
    taxLabel: product.taxLabel ?? undefined,
    taxRate: product.taxRate,
    unit: product.unit,
    ...overrides,
  }
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, '')
}

function isProductLowStock(product: Product) {
  return product.stock <= Math.max(product.minStock, 5)
}

function clampPercentage(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(999, value))
}

function DrawerShell({
  title,
  titleAccessory,
  onClose,
  children,
  footer,
}: DrawerShellProps) {
  return (
    <SideDrawer
      bodyClassName={styles.drawerBody}
      className={styles.drawerBackdrop}
      closeButtonClassName={styles.drawerClose}
      closeLabel="Cerrar"
      footer={footer}
      footerClassName={styles.drawerFooter}
      isOpen
      panelClassName={styles.drawer}
      title={title}
      titleAccessory={titleAccessory}
      onClose={onClose}
    >
      {children}
    </SideDrawer>
  )
}

function IconButton({ label, tooltip, onClick, children }: IconButtonProps) {
  return (
    <div className={styles.iconButtonWrap}>
      <button
        aria-label={label}
        className={styles.iconButton}
        type="button"
        onClick={onClick}
      >
        {children}
        <span className={styles.mobileActionLabel}>{label}</span>
      </button>
      <span className={styles.tooltipBubble}>{tooltip}</span>
    </div>
  )
}

function BoxIcon() {
  return (
    <svg aria-hidden="true" className={styles.iconSvg} viewBox="0 0 24 24">
      <path d="M4 7.5 12 4l8 3.5-8 3.5-8-3.5Zm2 3.15v5.35L11 18.2v-5.37l-5-2.18Zm7 7.55 5-2.2v-5.35l-5 2.18v5.37Z" />
    </svg>
  )
}

function TagsIcon() {
  return (
    <svg aria-hidden="true" className={styles.iconSvg} viewBox="0 0 24 24">
      <path d="M4 12.3V6.8c0-.99.81-1.8 1.8-1.8h5.5l8.7 8.7a1.8 1.8 0 0 1 0 2.55l-3.75 3.75a1.8 1.8 0 0 1-2.55 0L4 12.3Zm4.3-4.8a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z" />
    </svg>
  )
}

function TaxIcon() {
  return (
    <svg aria-hidden="true" className={styles.iconSvg} viewBox="0 0 24 24">
      <path d="M6 4h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm8 1.5V10h4.5" />
      <path d="M8 15h8M8 18h5M8 11h2" />
    </svg>
  )
}

function AdjustmentIcon() {
  return (
    <svg aria-hidden="true" className={styles.iconSvg} viewBox="0 0 24 24">
      <path d="M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3 3m-3-3 3-3" />
      <path d="M4 4v16m16-16v16" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" className={styles.iconSvg} viewBox="0 0 24 24">
      <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" className={styles.chevronIcon} viewBox="0 0 24 24">
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg aria-hidden="true" className={styles.alertIcon} viewBox="0 0 24 24">
      <path d="M12 3 2.8 20h18.4L12 3Z" />
      <path d="M12 9v5m0 3h.01" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg aria-hidden="true" className={styles.moreIcon} viewBox="0 0 24 24">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  )
}

export function RetailInventoryWorkspace() {
  const { languageCode } = useAppTranslation()
  const copy = getInventoryCopy(languageCode)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const productsQuery = useProductsQuery()
  const categoriesQuery = useInventoryCategoriesQuery()
  const lowStockQuery = useInventoryLowStockQuery()
  const createCategoryMutation = useCreateInventoryCategoryMutation()
  const deleteCategoryMutation = useDeleteInventoryCategoryMutation()
  const updateCategoryMutation = useUpdateInventoryCategoryMutation()
  const createAdjustmentMutation = useCreateInventoryAdjustmentMutation()
  const updateProductTaxesMutation = useUpdateInventoryProductTaxesMutation()
  const updateProductMutation = useUpdateProductMutation()
  const registerPurchaseMutation = useRegisterInventoryPurchaseMutation()
  const businessSettingsQuery = useBusinessSettingsQuery()
  const updateBusinessSettingsMutation = useUpdateBusinessSettingsMutation()
  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data])
  const categories = useMemo(
    () => categoriesQuery.data ?? [],
    [categoriesQuery.data],
  )
  const businessSettings = businessSettingsQuery.data
  const lowStockAlerts = useMemo(
    () => lowStockQuery.data ?? [],
    [lowStockQuery.data],
  )
  const [isPremiumBannerVisible, setPremiumBannerVisible] = useState(true)
  const [feedbackMessage, setFeedbackMessage] = useState<FeedbackMessage | null>(
    null,
  )
  const [productDrafts, setProductDrafts] = useState<InlineProductDrafts>({})
  const [savingProductField, setSavingProductField] = useState<string | null>(
    null,
  )
  const [searchTerm, setSearchTerm] = useState('')
  const [categorySearchTerm, setCategorySearchTerm] = useState('')
  const [assignedProductSearchTerm, setAssignedProductSearchTerm] = useState('')
  const [taxProductSearchTerm, setTaxProductSearchTerm] = useState('')
  const [isCreateMenuOpen, setCreateMenuOpen] = useState(false)
  const createMenuRef = useRef<HTMLDivElement>(null)
  const tableSectionRef = useRef<HTMLElement>(null)
  const [isCategoriesDrawerOpen, setCategoriesDrawerOpen] = useState(false)
  const [isCategoryEditorOpen, setCategoryEditorOpen] = useState(false)
  const [isSharePhoneModalOpen, setSharePhoneModalOpen] = useState(false)
  const [isTaxesDrawerOpen, setTaxesDrawerOpen] = useState(false)
  const [isTaxPickerOpen, setTaxPickerOpen] = useState(false)
  const [isTaxOptionsOpen, setTaxOptionsOpen] = useState(false)
  const [isPurchaseDrawerOpen, setPurchaseDrawerOpen] = useState(false)
  const [isAdjustmentDrawerOpen, setAdjustmentDrawerOpen] = useState(false)
  const [shareCatalogPhone, setShareCatalogPhone] = useState('')
  const [activeInventoryFilter, setActiveInventoryFilter] =
    useState<InventoryFilter>('ALL')
  const [inventorySort, setInventorySort] = useState<InventorySort>('STOCK_ASC')
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)
  const [taxPickerCategoryId, setTaxPickerCategoryId] = useState<string | null>(
    null,
  )
  const [categoryEditorState, setCategoryEditorState] = useState<CategoryEditorState>(
    createDefaultCategoryEditorState(),
  )
  const [purchaseFormState, setPurchaseFormState] = useState<PurchaseFormState>(
    createDefaultPurchaseFormState(),
  )
  const [adjustmentFormState, setAdjustmentFormState] =
    useState<AdjustmentFormState>(createDefaultAdjustmentFormState())
  const [taxFormState, setTaxFormState] = useState<TaxFormState>(
    createDefaultTaxFormState(),
  )
  const productId = searchParams.get('productId')
  const rawTab = searchParams.get('tab')
  const productWorkspaceReturnPath =
    searchParams.get('returnTo') === routeSegments.sales ? routePaths.sales : null
  const productWorkspaceTab: RetailProductCreateWorkspaceTab =
    rawTab === 'variants' || rawTab === 'measures' ? rawTab : 'basic'
  const isManualCreateDrawerOpen = searchParams.get('create') === 'manual'
  const isProductWorkspaceOpen = isManualCreateDrawerOpen || Boolean(productId)
  const activeTaxOption = inventoryTaxOptions.find(
    (option) => option.id === taxFormState.selectedOptionId,
  )
  const selectedAdjustmentProduct = products.find(
    (product) => product.id === adjustmentFormState.productId,
  )
  const estimatedPurchaseTotal =
    parsePositiveNumber(purchaseFormState.quantity) *
    parsePositiveNumber(purchaseFormState.unitCost)

  useEffect(() => {
    setShareCatalogPhone(businessSettings?.phone ?? '')
  }, [businessSettings?.phone])

  useEffect(() => {
    setProductDrafts(
      Object.fromEntries(
        products.map((product) => [product.id, createInlineProductDraft(product)]),
      ),
    )
  }, [products])

  useEffect(() => {
    if (!isCreateMenuOpen) {
      return undefined
    }

    function handlePointerDown(event: PointerEvent) {
      if (!createMenuRef.current?.contains(event.target as Node)) {
        setCreateMenuOpen(false)
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setCreateMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isCreateMenuOpen])

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  )

  const totalInventoryCost = useMemo(
    () =>
      products.reduce(
        (totalCost, product) => totalCost + product.cost * product.stock,
        0,
      ),
    [products],
  )

  const visibleProducts = useMemo(() => {
    const normalizedSearchTerm = searchTerm.trim().toLowerCase()

    return products
      .filter((product) => matchesProductSearch(product, normalizedSearchTerm))
      .filter((product) =>
        activeCategoryId ? product.categoryId === activeCategoryId : true,
      )
      .filter((product) =>
        activeInventoryFilter === 'LOW' ? isProductLowStock(product) : true,
      )
      .sort((firstProduct, secondProduct) => {
        const stockDifference = firstProduct.stock - secondProduct.stock

        if (stockDifference !== 0) {
          return inventorySort === 'STOCK_ASC' ? stockDifference : -stockDifference
        }

        return firstProduct.name.localeCompare(secondProduct.name)
      })
  }, [activeCategoryId, activeInventoryFilter, inventorySort, products, searchTerm])

  const filteredCategories = useMemo(() => {
    const normalizedSearchTerm = categorySearchTerm.trim().toLowerCase()

    return categories.filter((category) =>
      category.name.toLowerCase().includes(normalizedSearchTerm),
    )
  }, [categories, categorySearchTerm])

  const categoryEditorProducts = useMemo(() => {
    const normalizedSearchTerm = assignedProductSearchTerm.trim().toLowerCase()

    return products
      .filter((product) => matchesProductSearch(product, normalizedSearchTerm))
      .sort((firstProduct, secondProduct) =>
        firstProduct.name.localeCompare(secondProduct.name),
      )
  }, [assignedProductSearchTerm, products])

  const taxPickerProducts = useMemo(() => {
    const normalizedSearchTerm = taxProductSearchTerm.trim().toLowerCase()

    return products
      .filter((product) => matchesProductSearch(product, normalizedSearchTerm))
      .filter((product) =>
        taxPickerCategoryId ? product.categoryId === taxPickerCategoryId : true,
      )
      .sort((firstProduct, secondProduct) =>
        firstProduct.name.localeCompare(secondProduct.name),
      )
  }, [products, taxPickerCategoryId, taxProductSearchTerm])

  function resetFeedback() {
    setFeedbackMessage(null)
  }

  function handleOpenManualCreateDrawer() {
    setCreateMenuOpen(false)
    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams)
      nextParams.set('create', 'manual')
      nextParams.delete('productId')
      nextParams.delete('tab')
      nextParams.delete('returnTo')
      return nextParams
    })
  }

  function handleOpenEditProduct(nextProductId: string) {
    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams)
      nextParams.delete('create')
      nextParams.delete('returnTo')
      nextParams.set('productId', nextProductId)
      nextParams.set('tab', 'basic')
      return nextParams
    })
  }

  function handleProductWorkspaceTabChange(
    nextTab: RetailProductCreateWorkspaceTab,
  ) {
    if (!productId) {
      return
    }

    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams)
      nextParams.set('productId', productId)
      nextParams.set('tab', nextTab)
      return nextParams
    })
  }

  function handleCloseProductWorkspace() {
    if (productWorkspaceReturnPath) {
      navigate(productWorkspaceReturnPath, { replace: true })
      return
    }

    setSearchParams((currentParams) => {
      const nextParams = new URLSearchParams(currentParams)
      nextParams.delete('create')
      nextParams.delete('productId')
      nextParams.delete('tab')
      nextParams.delete('returnTo')
      return nextParams
    })
  }

  function handleCloseCategoryEditor() {
    setCategoryEditorOpen(false)
    setCategoryEditorState(createDefaultCategoryEditorState())
    setAssignedProductSearchTerm('')
  }

  function handleClosePurchaseDrawer() {
    setPurchaseDrawerOpen(false)
    setPurchaseFormState(createDefaultPurchaseFormState())
  }

  function handleCloseAdjustmentDrawer() {
    setAdjustmentDrawerOpen(false)
    setAdjustmentFormState(createDefaultAdjustmentFormState())
  }

  function handleCloseTaxesDrawer() {
    setTaxesDrawerOpen(false)
    setTaxPickerOpen(false)
    setTaxOptionsOpen(false)
    setTaxPickerCategoryId(null)
    setTaxProductSearchTerm('')
    setTaxFormState(createDefaultTaxFormState())
  }

  function handleOpenCreateCategory() {
    resetFeedback()
    setCategoryEditorState(createDefaultCategoryEditorState())
    setCategoryEditorOpen(true)
  }

  function handleOpenEditCategory(category: InventoryProductCategory) {
    resetFeedback()
    setCategoryEditorState({
      id: category.id,
      name: category.name,
      isVisibleInCatalog: category.isVisibleInCatalog,
      productIds: products
        .filter((product) => product.categoryId === category.id)
        .map((product) => product.id),
    })
    setCategoryEditorOpen(true)
  }

  function handleToggleCategoryProduct(productId: string) {
    setCategoryEditorState((currentState) => ({
      ...currentState,
      productIds: currentState.productIds.includes(productId)
        ? currentState.productIds.filter((currentProductId) => currentProductId !== productId)
        : [...currentState.productIds, productId],
    }))
  }

  function handleProductDraftChange(
    productId: string,
    field: InlineProductField,
    value: string,
  ) {
    setProductDrafts((currentDrafts) => ({
      ...currentDrafts,
      [productId]: {
        ...(currentDrafts[productId] ?? {
          price: '',
          cost: '',
          stock: '',
        }),
        [field]: value,
      },
    }))
  }

  function resetProductDraftField(product: Product, field: InlineProductField) {
    const nextDraft = createInlineProductDraft(product)

    setProductDrafts((currentDrafts) => ({
      ...currentDrafts,
      [product.id]: {
        ...(currentDrafts[product.id] ?? nextDraft),
        [field]: nextDraft[field],
      },
    }))
  }

  async function handleCommitProductDraft(
    product: Product,
    field: InlineProductField,
  ) {
    const currentDraft = productDrafts[product.id] ?? createInlineProductDraft(product)
    const parsedValue =
      field === 'stock'
        ? parseEditableStock(currentDraft[field])
        : parseEditableDecimal(currentDraft[field])

    if (!Number.isFinite(parsedValue)) {
      resetProductDraftField(product, field)
      setFeedbackMessage({
        tone: 'error',
        text: 'Ingresa un valor válido para actualizar el producto.',
      })
      return
    }

    const normalizedValue =
      field === 'stock'
        ? Math.max(0, Math.floor(parsedValue))
        : Math.round((parsedValue + Number.EPSILON) * 100) / 100
    const currentValue = product[field]

    setProductDrafts((currentDrafts) => ({
      ...currentDrafts,
      [product.id]: {
        ...currentDraft,
        [field]: formatEditableNumber(normalizedValue),
      },
    }))

    if (Math.abs(currentValue - normalizedValue) < 0.005) {
      return
    }

    const mutationKey = `${product.id}:${field}`
    setSavingProductField(mutationKey)
    resetFeedback()

    try {
      await updateProductMutation.mutateAsync({
        productId: product.id,
        input: createProductUpdateInput(product, {
          [field]: normalizedValue,
        }),
      })
      setFeedbackMessage({
        tone: 'success',
        text: 'Producto actualizado.',
      })
    } catch (error) {
      resetProductDraftField(product, field)
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(error, 'No fue posible actualizar el producto.'),
      })
    } finally {
      setSavingProductField((currentKey) =>
        currentKey === mutationKey ? null : currentKey,
      )
    }
  }

  function handleInlineProductKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    product: Product,
    field: InlineProductField,
  ) {
    event.stopPropagation()

    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      resetProductDraftField(product, field)
      event.currentTarget.blur()
    }
  }

  async function handleSaveCategory() {
    resetFeedback()

    const input: InventoryProductCategoryInput = {
      name: categoryEditorState.name.trim(),
      isVisibleInCatalog: categoryEditorState.isVisibleInCatalog,
      productIds: categoryEditorState.productIds,
    }

    try {
      if (categoryEditorState.id) {
        await updateCategoryMutation.mutateAsync({
          categoryId: categoryEditorState.id,
          input,
        })
      } else {
        await createCategoryMutation.mutateAsync(input)
      }

      setFeedbackMessage({
        tone: 'success',
        text:
          categoryEditorState.id === null
            ? copy.createCategorySubmit
            : copy.updateCategorySubmit,
      })
      handleCloseCategoryEditor()
    } catch (error) {
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(error, 'No fue posible guardar la categoría.'),
      })
    }
  }

  async function handleDeleteCategory() {
    if (!categoryEditorState.id) {
      return
    }

    resetFeedback()

    try {
      await deleteCategoryMutation.mutateAsync(categoryEditorState.id)
      if (activeCategoryId === categoryEditorState.id) {
        setActiveCategoryId(null)
      }
      setFeedbackMessage({
        tone: 'success',
        text: copy.deleteCategorySuccess,
      })
      handleCloseCategoryEditor()
    } catch (error) {
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(error, 'No fue posible eliminar la categoría.'),
      })
    }
  }

  async function handleDownloadInventory() {
    resetFeedback()

    try {
      const { blob, filename } = await exportInventoryReport({
        search: searchTerm,
        categoryId: activeCategoryId ?? undefined,
        lowStockOnly: activeInventoryFilter === 'LOW',
      })

      downloadBlobFile(blob, filename ?? 'inventory-report.csv')
      setFeedbackMessage({
        tone: 'success',
        text: copy.exportSuccess,
      })
    } catch (error) {
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(error, 'No fue posible descargar el inventario.'),
      })
    }
  }

  async function handleShareCatalog() {
    resetFeedback()

    if (!businessSettings?.phone) {
      setShareCatalogPhoneModalOpen()
      return
    }

    await handleCopyCatalogLink()
  }

  function setShareCatalogPhoneModalOpen() {
    setShareCatalogPhone(normalizePhone(businessSettings?.phone ?? ''))
    setSharePhoneModalOpen(true)
  }

  async function handleCopyCatalogLink() {
    try {
      const catalogUrl = buildConfiguredCatalogUrl({
        businessName: businessSettings?.businessName,
        businessId: businessSettings?.id,
        catalogSlug: businessSettings?.catalogSlug,
      })
      await navigator.clipboard.writeText(catalogUrl)
      setFeedbackMessage({
        tone: 'info',
        text: copy.shareSuccess,
      })
    } catch (error) {
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(error, 'No fue posible copiar el catálogo.'),
      })
    }
  }

  async function handleUpdatePhoneAndShareCatalog() {
    resetFeedback()

    const normalizedPhone = normalizePhone(shareCatalogPhone)

    if (normalizedPhone.length < 7) {
      setFeedbackMessage({
        tone: 'error',
        text: 'Escribe un número de teléfono válido.',
      })
      return
    }

    try {
      await updateBusinessSettingsMutation.mutateAsync({
        phone: normalizedPhone,
      })
      setSharePhoneModalOpen(false)
      await handleCopyCatalogLink()
    } catch (error) {
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(
          error,
          'No fue posible actualizar el número del negocio.',
        ),
      })
    }
  }

  async function handleRegisterPurchase() {
    resetFeedback()

    const quantity = parsePositiveNumber(purchaseFormState.quantity)
    const unitCost = parsePositiveNumber(purchaseFormState.unitCost)

    if (!purchaseFormState.productId || quantity <= 0 || unitCost <= 0) {
      setFeedbackMessage({
        tone: 'error',
        text: 'Completa producto, cantidad y costo unitario.',
      })
      return
    }

    try {
      await registerPurchaseMutation.mutateAsync({
        productId: purchaseFormState.productId,
        quantity,
        unitCost,
        reason: normalizeOptionalText(purchaseFormState.reason),
      })

      setPurchaseDrawerOpen(false)
      setPurchaseFormState(createDefaultPurchaseFormState())
      setFeedbackMessage({
        tone: 'success',
        text: copy.purchaseSubmit,
      })
    } catch (error) {
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(error, 'No fue posible registrar la compra.'),
      })
    }
  }

  async function handleRegisterAdjustment() {
    resetFeedback()

    const quantity =
      adjustmentFormState.type === 'ADJUSTMENT'
        ? parseNonNegativeNumber(adjustmentFormState.quantity)
        : parsePositiveNumber(adjustmentFormState.quantity)

    if (!adjustmentFormState.productId || quantity < 0) {
      setFeedbackMessage({
        tone: 'error',
        text: copy.adjustmentValidation,
      })
      return
    }

    const input: InventoryAdjustmentInput = {
      productId: adjustmentFormState.productId,
      type: adjustmentFormState.type,
      quantity,
      reason: normalizeOptionalText(adjustmentFormState.reason),
    }

    try {
      await createAdjustmentMutation.mutateAsync(input)

      setAdjustmentDrawerOpen(false)
      setAdjustmentFormState(createDefaultAdjustmentFormState())
      setFeedbackMessage({
        tone: 'success',
        text: copy.adjustmentSuccess,
      })
    } catch (error) {
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(error, 'No fue posible ajustar el inventario.'),
      })
    }
  }

  async function handleSaveTaxes() {
    resetFeedback()

    if (!activeTaxOption || taxFormState.productIds.length === 0) {
      setFeedbackMessage({
        tone: 'error',
        text: 'Selecciona productos y un impuesto base.',
      })
      return
    }

    try {
      await updateProductTaxesMutation.mutateAsync({
        productIds: taxFormState.productIds,
        taxLabel: activeTaxOption.label,
        taxRate: activeTaxOption.rate,
      })

      setTaxesDrawerOpen(false)
      setTaxOptionsOpen(false)
      setTaxPickerOpen(false)
      setTaxFormState(createDefaultTaxFormState())
      setFeedbackMessage({
        tone: 'success',
        text: copy.saveChanges,
      })
    } catch (error) {
      setFeedbackMessage({
        tone: 'error',
        text: getErrorMessage(error, 'No fue posible actualizar los impuestos.'),
      })
    }
  }

  const categoryEditorFooter = isCategoryEditorOpen ? (
    <>
      <button
        className={retailStyles.buttonDark}
        disabled={
          categoryEditorState.name.trim().length < 2 ||
          createCategoryMutation.isPending ||
          updateCategoryMutation.isPending
        }
        type="button"
        onClick={() => {
          void handleSaveCategory()
        }}
      >
        {categoryEditorState.id
          ? copy.updateCategorySubmit
          : copy.createCategorySubmit}
      </button>
      {categoryEditorState.id ? (
        <button
          className={styles.deleteCategoryButton}
          disabled={deleteCategoryMutation.isPending}
          type="button"
          onClick={() => {
            void handleDeleteCategory()
          }}
        >
          {copy.deleteCategory}
        </button>
      ) : null}
    </>
  ) : undefined

  if (isProductWorkspaceOpen) {
    return (
      <RetailProductCreateWorkspace
        initialTab={productWorkspaceTab}
        productId={productId}
        onBack={handleCloseProductWorkspace}
        onTabChange={handleProductWorkspaceTabChange}
      />
    )
  }

  return (
    <RetailPageLayout
      bodyClassName={styles.dashboardBody}
      title={copy.title}
      meta={<span>{copy.pageDescription}</span>}
      actions={
        <>
          <button
            className={styles.headerSecondaryButton}
            type="button"
            onClick={() => {
              resetFeedback()
              setCategoriesDrawerOpen(true)
            }}
          >
            <TagsIcon />
            <span>{copy.categories}</span>
          </button>

          <div className={styles.dropdownGroup} ref={createMenuRef}>
            <button
              aria-expanded={isCreateMenuOpen}
              aria-haspopup="menu"
              className={styles.headerPrimaryButton}
              type="button"
              onClick={() => setCreateMenuOpen((currentValue) => !currentValue)}
            >
              <span className={styles.buttonPlus}>+</span>
              <span>{copy.createProduct}</span>
              <span className={styles.buttonChevron}>⌄</span>
            </button>

            {isCreateMenuOpen ? (
              <div className={styles.dropdownMenu} role="menu">
                <button
                  className={styles.dropdownButton}
                  role="menuitem"
                  type="button"
                  onClick={handleOpenManualCreateDrawer}
                >
                  {copy.createProductsManual}
                </button>
                <button
                  className={`${styles.dropdownButton} ${styles.dropdownButtonMuted}`}
                  disabled
                  role="menuitem"
                  type="button"
                >
                  {copy.uploadProductsExcel}
                </button>
              </div>
            ) : null}
          </div>
        </>
      }
    >

      {feedbackMessage ? (
        <div
          aria-live={feedbackMessage.tone === 'error' ? 'assertive' : 'polite'}
          className={
            feedbackMessage.tone === 'error'
              ? styles.feedbackError
              : feedbackMessage.tone === 'info'
                ? styles.feedbackInfo
                : styles.feedbackSuccess
          }
          role={feedbackMessage.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{feedbackMessage.text}</span>
          <button
            aria-label="Cerrar mensaje"
            className={styles.feedbackClose}
            type="button"
            onClick={() => setFeedbackMessage(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {isPremiumBannerVisible && lowStockAlerts.length > 0 ? (
        <section className={styles.banner}>
          <div className={styles.bannerLead}>
            <AlertIcon />
            <div className={styles.bannerCopy}>
              <p className={styles.bannerTitle}>{copy.lowStockAlertTitle}</p>
              <p className={styles.bannerDescription}>
                {copy.lowStockAlertDescription.replace(
                  '{count}',
                  lowStockAlerts.length.toString(),
                )}
              </p>
            </div>
          </div>

          <button
            className={styles.bannerAction}
            type="button"
            onClick={() => {
              setActiveInventoryFilter('LOW')
              setActiveCategoryId(null)
              window.requestAnimationFrame(() => {
                tableSectionRef.current?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'start',
                })
                tableSectionRef.current?.focus({ preventScroll: true })
              })
            }}
          >
            {copy.viewProducts}
          </button>
          <button
            aria-label="Cerrar alerta"
            className={styles.bannerClose}
            type="button"
            onClick={() => setPremiumBannerVisible(false)}
          >
            ×
          </button>
        </section>
      ) : null}

      <section className={styles.summaryGrid}>
        <article className={styles.summaryCard}>
          <div className={styles.summaryCardHeader}>
            <span className={styles.summaryIcon}><BoxIcon /></span>
            <span>{copy.totalReferences}</span>
          </div>
          <strong>{products.length.toLocaleString()}</strong>
          <small>{copy.referencesHint}</small>
        </article>

        <article className={styles.summaryCard}>
          <div className={styles.summaryCardHeader}>
            <span className={`${styles.summaryIcon} ${styles.summaryIconGreen}`}>
              <span>$</span>
            </span>
            <span>{copy.totalInventoryCost}</span>
          </div>
          <strong>{formatCurrency(totalInventoryCost)}</strong>
          <small>{copy.inventoryValuationHint}</small>
        </article>

        <article className={styles.promoCard}>
          <span className={styles.promoBadge}>{copy.newModule}</span>
          <strong>{copy.auditTitle}</strong>
          <p>{copy.auditDescription}</p>
        </article>
      </section>

      <section
        className={retailStyles.tableCard}
        ref={tableSectionRef}
        tabIndex={-1}
      >
        <div className={styles.tableToolbar}>
          <div className={styles.tableFilters}>
            <label className={styles.tableSearch}>
              <span aria-hidden="true">⌕</span>
              <input
                placeholder={copy.searchPlaceholder}
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </label>
            <label className={styles.compactSelectWrap}>
              <span aria-hidden="true">≡</span>
              <select
                aria-label={copy.categories}
                className={styles.compactSelect}
                value={activeCategoryId ?? ''}
                onChange={(event) => {
                  setActiveCategoryId(event.target.value || null)
                  setActiveInventoryFilter('ALL')
                }}
              >
                <option value="">{copy.allCategories}</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.compactSelectWrap}>
              <span aria-hidden="true">●</span>
              <select
                aria-label={copy.stockStatus}
                className={styles.compactSelect}
                value={activeInventoryFilter}
                onChange={(event) =>
                  setActiveInventoryFilter(event.target.value as InventoryFilter)
                }
              >
                <option value="ALL">{copy.allProducts}</option>
                <option value="LOW">{copy.lowStockOnly}</option>
              </select>
            </label>

            <label className={styles.compactSelectWrap}>
              <span aria-hidden="true">↕</span>
              <select
                aria-label={copy.stockOrder}
                className={styles.compactSelect}
                value={inventorySort}
                onChange={(event) => setInventorySort(event.target.value as InventorySort)}
              >
                <option value="STOCK_ASC">{copy.stockAscending}</option>
                <option value="STOCK_DESC">{copy.stockDescending}</option>
              </select>
            </label>
          </div>

          <div className={styles.tableToolbarRight}>
            <span className={styles.resultsCount}>
              {copy.showingCount
                .replace('{visible}', visibleProducts.length.toString())
                .replace('{total}', products.length.toString())}
            </span>
            <div className={styles.tableActions}>
              <IconButton
                label={copy.virtualCatalog}
                tooltip={copy.virtualCatalog}
                onClick={() => {
                  void handleShareCatalog()
                }}
              >
                <BoxIcon />
              </IconButton>
              <IconButton
                label={copy.registerPurchase}
                tooltip={copy.registerPurchase}
                onClick={() => setPurchaseDrawerOpen(true)}
              >
                <BoxIcon />
              </IconButton>
              <IconButton
                label={copy.adjustInventory}
                tooltip={copy.adjustInventory}
                onClick={() => setAdjustmentDrawerOpen(true)}
              >
                <AdjustmentIcon />
              </IconButton>
              <IconButton
                label={copy.productTaxes}
                tooltip={copy.productTaxes}
                onClick={() => setTaxesDrawerOpen(true)}
              >
                <TaxIcon />
              </IconButton>
              <IconButton
                label={copy.downloadInventory}
                tooltip={copy.downloadInventory}
                onClick={() => {
                  void handleDownloadInventory()
                }}
              >
                <DownloadIcon />
              </IconButton>
            </div>
          </div>
        </div>
        <div className={styles.tableScroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{copy.productColumn}</th>
                <th>{copy.priceColumn}</th>
                <th>{copy.costColumn}</th>
                <th>{copy.stockColumn}</th>
                <th>{copy.marginColumn}</th>
                <th aria-label={copy.actionsColumn} />
              </tr>
            </thead>
            <tbody>
              {visibleProducts.map((product) => {
                const productDraft =
                  productDrafts[product.id] ?? createInlineProductDraft(product)
                const productImageUrl = resolveProductImageUrl(product.imageUrls)
                const gain = product.price - product.cost
                const margin =
                  product.price > 0
                    ? clampPercentage((gain / product.price) * 100)
                    : 0
                const isLowStock = isProductLowStock(product)

                return (
                  <tr
                    key={product.id}
                    className={isLowStock ? styles.tableRowLowStock : undefined}
                  >
                    <td>
                      <div className={styles.productCell}>
                        {productImageUrl ? (
                          <img
                            alt=""
                            className={styles.productAvatarImage}
                            src={productImageUrl}
                          />
                        ) : (
                          <span className={styles.productAvatar}>t</span>
                        )}
                        <div className={styles.productCopy}>
                          <p className={styles.productName}>{product.name}</p>
                          <p className={styles.productMeta}>
                            {categoryNameById.get(product.categoryId ?? '') ??
                              copy.uncategorized}
                            {product.taxLabel ? ` · ${product.taxLabel}` : ''}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <label
                        className={styles.inlineEditBox}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className={styles.inlineCurrencyPrefix}>$</span>
                        <input
                          aria-label={`Precio de ${product.name}`}
                          className={styles.inlineEditInput}
                          disabled={savingProductField === `${product.id}:price`}
                          inputMode="decimal"
                          type="text"
                          value={productDraft.price}
                          onBlur={() => {
                            void handleCommitProductDraft(product, 'price')
                          }}
                          onChange={(event) =>
                            handleProductDraftChange(
                              product.id,
                              'price',
                              event.target.value,
                            )
                          }
                          onFocus={(event) => event.stopPropagation()}
                          onKeyDown={(event) =>
                            handleInlineProductKeyDown(event, product, 'price')
                          }
                        />
                      </label>
                    </td>
                    <td>
                      <label
                        className={styles.inlineEditBox}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className={styles.inlineCurrencyPrefix}>$</span>
                        <input
                          aria-label={`Costo de ${product.name}`}
                          className={styles.inlineEditInput}
                          disabled={savingProductField === `${product.id}:cost`}
                          inputMode="decimal"
                          type="text"
                          value={productDraft.cost}
                          onBlur={() => {
                            void handleCommitProductDraft(product, 'cost')
                          }}
                          onChange={(event) =>
                            handleProductDraftChange(
                              product.id,
                              'cost',
                              event.target.value,
                            )
                          }
                          onFocus={(event) => event.stopPropagation()}
                          onKeyDown={(event) =>
                            handleInlineProductKeyDown(event, product, 'cost')
                          }
                        />
                      </label>
                    </td>
                    <td>
                      <label
                        className={
                          isLowStock
                            ? `${styles.inlineEditBox} ${styles.valueBoxWarning}`
                            : styles.inlineEditBox
                        }
                        onClick={(event) => event.stopPropagation()}
                      >
                        <input
                          aria-label={`Cantidad disponible de ${product.name}`}
                          className={styles.inlineEditInput}
                          disabled={savingProductField === `${product.id}:stock`}
                          inputMode="numeric"
                          min="0"
                          step="1"
                          type="text"
                          value={productDraft.stock}
                          onBlur={() => {
                            void handleCommitProductDraft(product, 'stock')
                          }}
                          onChange={(event) =>
                            handleProductDraftChange(
                              product.id,
                              'stock',
                              event.target.value,
                            )
                          }
                          onFocus={(event) => event.stopPropagation()}
                          onKeyDown={(event) =>
                            handleInlineProductKeyDown(event, product, 'stock')
                          }
                        />
                      </label>
                    </td>
                    <td>
                      <div className={styles.gainCell}>
                        <span className={styles.marginPill}>
                          {`${margin.toFixed(1)}%`}
                        </span>
                      </div>
                    </td>
                    <td>
                      <button
                        aria-label={`${copy.editProduct}: ${product.name}`}
                        className={styles.rowActionButton}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          handleOpenEditProduct(product.id)
                        }}
                      >
                        <MoreIcon />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {visibleProducts.length === 0 ? (
          <div className={styles.emptyState}>
            {products.length === 0 ? (
              <>
                <RetailEmptyState
                  description={copy.emptyDescription}
                  title={copy.emptyTitle}
                />
                <div className={styles.emptyActions}>
                  <button
                    className={retailStyles.buttonOutline}
                    type="button"
                    onClick={handleOpenManualCreateDrawer}
                  >
                    {copy.createManual}
                  </button>
                </div>
              </>
            ) : (
              <RetailEmptyState description={copy.noResults} title={copy.title} />
            )}
          </div>
        ) : null}
      </section>

      {isCategoriesDrawerOpen ? (
        <DrawerShell
          footer={categoryEditorFooter}
          title={copy.categories}
          onClose={() => {
            setCategoriesDrawerOpen(false)
            handleCloseCategoryEditor()
          }}
        >
          {isCategoryEditorOpen ? (
            <div className={styles.drawerStack}>
              <button
                className={styles.backButton}
                type="button"
                onClick={handleCloseCategoryEditor}
              >
                ← {copy.categories}
              </button>

              <label className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>{copy.categoryName}</span>
                <input
                  className={styles.textInput}
                  placeholder={copy.categoryNamePlaceholder}
                  type="text"
                  value={categoryEditorState.name}
                  onChange={(event) =>
                    setCategoryEditorState((currentState) => ({
                      ...currentState,
                      name: event.target.value,
                    }))
                  }
                />
              </label>

              <button
                className={styles.toggleCard}
                type="button"
                onClick={() =>
                  setCategoryEditorState((currentState) => ({
                    ...currentState,
                    isVisibleInCatalog: !currentState.isVisibleInCatalog,
                  }))
                }
              >
                <div>
                  <p className={styles.toggleTitle}>{copy.showInStore}</p>
                  <p className={styles.toggleHint}>{copy.showInStoreHint}</p>
                </div>
                <span
                  className={
                    categoryEditorState.isVisibleInCatalog
                      ? styles.toggleActive
                      : styles.toggleInactive
                  }
                >
                  <span className={styles.toggleThumb} />
                </span>
              </button>

              <label className={styles.searchFieldDrawer}>
                <input
                  className={styles.searchInput}
                  placeholder={copy.searchProduct}
                  type="search"
                  value={assignedProductSearchTerm}
                  onChange={(event) => setAssignedProductSearchTerm(event.target.value)}
                />
              </label>

              <div className={styles.selectionList}>
                {categoryEditorProducts.map((product) => (
                  <label className={styles.selectionRow} key={product.id}>
                    <input
                      checked={categoryEditorState.productIds.includes(product.id)}
                      type="checkbox"
                      onChange={() => handleToggleCategoryProduct(product.id)}
                    />
                    <span className={styles.selectionName}>{product.name}</span>
                    <span className={styles.selectionPrice}>
                      {formatCurrency(product.price)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.drawerStack}>
              <button
                className={styles.createCategoryCard}
                type="button"
                onClick={handleOpenCreateCategory}
              >
                <span className={styles.createCategoryIcon}>+</span>
                <span>
                  <strong>{copy.createCategory}</strong>
                  <small>{copy.createCategoryHint}</small>
                </span>
              </button>

              <label className={styles.searchFieldDrawer}>
                <input
                  className={styles.searchInput}
                  placeholder={copy.searchCategory}
                  type="search"
                  value={categorySearchTerm}
                  onChange={(event) => setCategorySearchTerm(event.target.value)}
                />
              </label>

              <div className={styles.categoryList}>
                {filteredCategories.map((category) => (
                  <button
                    className={styles.categoryCard}
                    key={category.id}
                    type="button"
                    onClick={() => handleOpenEditCategory(category)}
                  >
                    <div className={styles.categoryCardCopy}>
                      <span className={styles.categoryCardTitle}>{category.name}</span>
                      <span className={styles.categoryCardMeta}>
                        <span
                          className={
                            category.isVisibleInCatalog
                              ? styles.statusDotVisible
                              : styles.statusDotHidden
                          }
                        />
                        {category.isVisibleInCatalog
                          ? copy.visibilityYes
                          : copy.visibilityNo}
                      </span>
                    </div>
                    <ChevronRightIcon />
                  </button>
                ))}
              </div>
            </div>
          )}
        </DrawerShell>
      ) : null}

      <ModalShell
        ariaLabel={copy.shareCatalogPhoneTitle}
        className={styles.centeredModalBackdrop}
        closeButtonClassName={styles.drawerClose}
        closeLabel="Cerrar"
        isOpen={isSharePhoneModalOpen}
        panelClassName={styles.centeredModal}
        onClose={() => setSharePhoneModalOpen(false)}
      >
        <div className={styles.drawerHeader}>
          <h3 className={styles.drawerTitle}>{copy.shareCatalogPhoneTitle}</h3>
        </div>

        <p className={styles.drawerDescription}>
          {copy.shareCatalogPhoneDescription}
        </p>

        <label className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>{copy.shareCatalogPhoneLabel}</span>
          <div className={styles.phoneInputWrap}>
            <span className={styles.phonePrefix}>CO</span>
            <input
              className={styles.textInput}
              inputMode="tel"
              placeholder={copy.shareCatalogPhonePlaceholder}
              type="tel"
              value={shareCatalogPhone}
              onChange={(event) => setShareCatalogPhone(event.target.value)}
            />
          </div>
        </label>

        <div className={styles.phoneModalActions}>
          <button
            className={retailStyles.buttonDark}
            disabled={
              normalizePhone(shareCatalogPhone).length < 7 ||
              updateBusinessSettingsMutation.isPending
            }
            type="button"
            onClick={() => {
              void handleUpdatePhoneAndShareCatalog()
            }}
          >
            {copy.shareCatalogPhoneSubmit}
          </button>
        </div>
      </ModalShell>

      {isTaxesDrawerOpen ? (
        <DrawerShell
          footer={
            <>
              <button
                className={styles.footerCancelButton}
                type="button"
                onClick={handleCloseTaxesDrawer}
              >
                {copy.cancel}
              </button>
              <button
                className={styles.drawerPrimaryButton}
                disabled={!activeTaxOption || taxFormState.productIds.length === 0}
                type="button"
                onClick={() => {
                  void handleSaveTaxes()
                }}
              >
                {copy.saveChanges}
              </button>
            </>
          }
          title={copy.productTaxes}
          onClose={handleCloseTaxesDrawer}
        >
          <div className={styles.drawerStack}>
            <div className={styles.taxSelectionCard}>
              <span className={styles.taxSelectionIcon}>□</span>
              <div>
                <strong>{copy.selectedProductsTitle}</strong>
                <p>
                  {copy.selectedProductsDescription.replace(
                    '{count}',
                    taxFormState.productIds.length.toString(),
                  )}
                </p>
                <button
                  className={styles.taxSelectionLink}
                  type="button"
                  onClick={() => {
                    setTaxPickerCategoryId(activeCategoryId)
                    setTaxPickerOpen(true)
                  }}
                >
                  {copy.selectProductsInTable} →
                </button>
              </div>
            </div>

            <div className={styles.separator} />

            <span className={styles.sectionEyebrow}>{copy.taxConfiguration}</span>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{copy.taxBase}</span>
              <button
                className={styles.selectionTrigger}
                type="button"
                onClick={() => setTaxOptionsOpen((currentValue) => !currentValue)}
              >
                <span>{activeTaxOption?.label ?? copy.selectOption}</span>
                <ChevronRightIcon />
              </button>
              <small className={styles.fieldHint}>{copy.taxBaseHint}</small>
            </label>

            {isTaxOptionsOpen ? (
              <div className={styles.taxOptionsList}>
                {inventoryTaxOptions.map((option) => (
                  <button
                    className={styles.taxOptionButton}
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setTaxFormState((currentState) => ({
                        ...currentState,
                        selectedOptionId: option.id,
                      }))
                      setTaxOptionsOpen(false)
                    }}
                  >
                    <span
                      className={
                        taxFormState.selectedOptionId === option.id
                          ? styles.taxCheckboxActive
                          : styles.taxCheckbox
                      }
                    />
                    <div className={styles.taxOptionCopy}>
                      <span>{option.label}</span>
                      <small>{`${option.rate.toString()}%`}</small>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}

            <div className={styles.taxIncludedCard}>
              <TaxIcon />
              <span className={styles.taxIncludedCopy}>
                <span>{copy.taxIncludedInPrice}</span>
                <small>{copy.taxIncludedCoreHint}</small>
              </span>
              <span
                aria-checked="true"
                aria-disabled="true"
                aria-label={copy.enabled}
                className={styles.staticToggle}
                role="switch"
                tabIndex={0}
                title={copy.taxIncludedCoreHint}
              >
                <span />
              </span>
            </div>
          </div>

          <ModalShell
            ariaLabel={copy.selectProductsToModify}
            className={styles.selectorBackdrop}
            isOpen={isTaxPickerOpen}
            panelClassName={styles.selectorPanel}
            showCloseButton={false}
            onClose={() => setTaxPickerOpen(false)}
          >
            <div className={styles.selectorHeader}>
              <button
                className={styles.backButton}
                type="button"
                onClick={() => setTaxPickerOpen(false)}
              >
                ← {copy.selectProductsToModify}
              </button>
            </div>

            <div className={styles.selectorFilters}>
              <label className={styles.searchFieldDrawer}>
                <input
                  className={styles.searchInput}
                  placeholder={copy.searchProduct}
                  type="search"
                  value={taxProductSearchTerm}
                  onChange={(event) => setTaxProductSearchTerm(event.target.value)}
                />
              </label>

              <div className={styles.chipsRow}>
                <button
                  className={
                    taxPickerCategoryId === null ? styles.chipActive : styles.chip
                  }
                  type="button"
                  onClick={() => setTaxPickerCategoryId(null)}
                >
                  {copy.allChip}
                </button>
                {categories.map((category) => (
                  <button
                    className={
                      taxPickerCategoryId === category.id
                        ? styles.chipActive
                        : styles.chip
                    }
                    key={category.id}
                    type="button"
                    onClick={() => setTaxPickerCategoryId(category.id)}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.selectorTable}>
              <table className={styles.selectionTable}>
                <thead>
                  <tr>
                    <th />
                    <th>{copy.productColumn}</th>
                    <th>{copy.priceColumn}</th>
                    <th>{copy.costColumn}</th>
                    <th>{copy.taxBase}</th>
                  </tr>
                </thead>
                <tbody>
                  {taxPickerProducts.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <input
                          checked={taxFormState.productIds.includes(product.id)}
                          type="checkbox"
                          onChange={() =>
                            setTaxFormState((currentState) => ({
                              ...currentState,
                              productIds: currentState.productIds.includes(product.id)
                                ? currentState.productIds.filter(
                                    (currentProductId) =>
                                      currentProductId !== product.id,
                                  )
                                : [...currentState.productIds, product.id],
                            }))
                          }
                        />
                      </td>
                      <td>{product.name}</td>
                      <td>{formatCurrency(product.price)}</td>
                      <td>{formatCurrency(product.cost)}</td>
                      <td>{product.taxLabel ?? copy.selectOption}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.selectorFooter}>
              <button
                className={retailStyles.buttonDark}
                type="button"
                onClick={() => setTaxPickerOpen(false)}
              >
                {copy.continue}
              </button>
            </div>
          </ModalShell>
        </DrawerShell>
      ) : null}

      {isAdjustmentDrawerOpen ? (
        <DrawerShell
          footer={
            <>
              <button
                className={styles.footerCancelButton}
                type="button"
                onClick={handleCloseAdjustmentDrawer}
              >
                {copy.cancel}
              </button>
              <button
                className={styles.drawerPrimaryButton}
                disabled={
                  !adjustmentFormState.productId ||
                  (adjustmentFormState.type === 'ADJUSTMENT'
                    ? parseNonNegativeNumber(adjustmentFormState.quantity) < 0
                    : parsePositiveNumber(adjustmentFormState.quantity) <= 0) ||
                  createAdjustmentMutation.isPending
                }
                type="button"
                onClick={() => {
                  void handleRegisterAdjustment()
                }}
              >
                {copy.adjustmentSubmit}
              </button>
            </>
          }
          title={copy.adjustmentTitle}
          onClose={handleCloseAdjustmentDrawer}
        >
          <div className={styles.drawerStack}>
            <p className={styles.drawerDescription}>
              {copy.adjustmentDescription}
            </p>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{copy.purchaseProduct}</span>
              <select
                className={styles.selectInput}
                value={adjustmentFormState.productId}
                onChange={(event) =>
                  setAdjustmentFormState((currentState) => ({
                    ...currentState,
                    productId: event.target.value,
                  }))
                }
              >
                <option value="">{copy.selectOption}</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>
                {copy.adjustmentMovementType}
              </span>
              <select
                className={styles.selectInput}
                value={adjustmentFormState.type}
                onChange={(event) =>
                  setAdjustmentFormState((currentState) => ({
                    ...currentState,
                    type: event.target.value as ManualInventoryAdjustmentType,
                  }))
                }
              >
                <option value="OUT">{copy.adjustmentTypeOut}</option>
                <option value="ADJUSTMENT">
                  {copy.adjustmentTypeAdjustment}
                </option>
                <option value="IN">{copy.adjustmentTypeIn}</option>
              </select>
            </label>

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>
                {adjustmentFormState.type === 'ADJUSTMENT'
                  ? copy.adjustmentTargetStock
                  : copy.adjustmentQuantity}
              </span>
              <input
                className={styles.textInput}
                inputMode="numeric"
                min={adjustmentFormState.type === 'ADJUSTMENT' ? '0' : '1'}
                type="number"
                value={adjustmentFormState.quantity}
                onChange={(event) =>
                  setAdjustmentFormState((currentState) => ({
                    ...currentState,
                    quantity: event.target.value,
                  }))
                }
              />
            </label>

            {selectedAdjustmentProduct ? (
              <div className={styles.adjustmentSummary}>
                <span>{copy.adjustmentCurrentStock}</span>
                <strong>
                  {selectedAdjustmentProduct.stock.toString()}{' '}
                  {copy.adjustmentStockUnit}
                </strong>
              </div>
            ) : null}

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{copy.adjustmentReason}</span>
              <textarea
                className={styles.textareaInput}
                placeholder={copy.adjustmentReasonPlaceholder}
                rows={4}
                value={adjustmentFormState.reason}
                onChange={(event) =>
                  setAdjustmentFormState((currentState) => ({
                    ...currentState,
                    reason: event.target.value,
                  }))
                }
              />
            </label>
          </div>
        </DrawerShell>
      ) : null}

      {isPurchaseDrawerOpen ? (
        <DrawerShell
          titleAccessory={
            <span className={styles.drawerTitleIcon}>
              <BoxIcon />
            </span>
          }
          footer={
            <>
              <button
                className={styles.footerCancelButton}
                type="button"
                onClick={handleClosePurchaseDrawer}
              >
                {copy.cancel}
              </button>
              <button
                className={styles.drawerPrimaryButton}
                disabled={
                  !purchaseFormState.productId ||
                  parsePositiveNumber(purchaseFormState.quantity) <= 0 ||
                  parsePositiveNumber(purchaseFormState.unitCost) <= 0 ||
                  registerPurchaseMutation.isPending
                }
                type="button"
                onClick={() => {
                  void handleRegisterPurchase()
                }}
              >
                ◉ {copy.purchaseSubmit}
              </button>
            </>
          }
          title={copy.purchaseTitle}
          onClose={handleClosePurchaseDrawer}
        >
          <div className={styles.drawerStack}>
            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{copy.purchaseProduct} *</span>
              <select
                className={styles.selectInput}
                value={purchaseFormState.productId}
                onChange={(event) =>
                  setPurchaseFormState((currentState) => ({
                    ...currentState,
                    productId: event.target.value,
                  }))
                }
              >
                <option value="">{copy.selectOption}</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
              <small className={styles.fieldHint}>{copy.purchaseProductHint}</small>
            </label>

            <div className={styles.purchaseFieldsRow}>
              <label className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>{copy.purchaseQuantity} *</span>
                <input
                  className={styles.textInput}
                  inputMode="decimal"
                  min="1"
                  placeholder="Ej: 10"
                  step="1"
                  type="number"
                  value={purchaseFormState.quantity}
                  onChange={(event) =>
                    setPurchaseFormState((currentState) => ({
                      ...currentState,
                      quantity: event.target.value,
                    }))
                  }
                />
              </label>

              <label className={styles.fieldGroup}>
                <span className={styles.fieldLabel}>{copy.purchaseUnitCost} *</span>
                <input
                  className={styles.textInput}
                  inputMode="decimal"
                  min="0.01"
                  placeholder="$ 0.00"
                  step="0.01"
                  type="number"
                  value={purchaseFormState.unitCost}
                  onChange={(event) =>
                    setPurchaseFormState((currentState) => ({
                      ...currentState,
                      unitCost: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <div className={styles.purchaseTotalCard}>
              <span>{copy.estimatedTotal}</span>
              <strong>{formatCurrency(estimatedPurchaseTotal)}</strong>
            </div>

            <div className={styles.separator} />

            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{copy.purchaseReasonSupplier}</span>
              <textarea
                className={styles.textareaInput}
                placeholder={copy.purchaseReasonPlaceholder}
                rows={4}
                value={purchaseFormState.reason}
                onChange={(event) =>
                  setPurchaseFormState((currentState) => ({
                    ...currentState,
                    reason: event.target.value,
                  }))
                }
              />
            </label>
          </div>
        </DrawerShell>
      ) : null}

    </RetailPageLayout>
  )
}
