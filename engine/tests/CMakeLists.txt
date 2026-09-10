# Regressions for combinational design, state-preserving sequential layout, and simulation.
function(engine_regression name source)
  add_executable(${name} ${source})
  target_link_libraries(${name} PRIVATE autopr simon)
  target_compile_definitions(${name} PRIVATE IFCN_TEST_SOURCE_DIR="${PROJECT_SOURCE_DIR}")
  if(MSVC)
    target_compile_options(${name} PRIVATE /UNDEBUG)
  else()
    target_compile_options(${name} PRIVATE -UNDEBUG)
  endif()
  add_test(NAME ${name} COMMAND ${name} ${ARGN})
  set_tests_properties(${name} PROPERTIES TIMEOUT 45)
endfunction()

engine_regression(simulation_metrics SimulationMetricsUnitTest.cpp)
engine_regression(mapping_io_contraction MappingIoContractionUnitTest.cpp)
engine_regression(mapping_crossover MappingCrossoverUnitTest.cpp)
engine_regression(phase_aware_routing PhaseAwareRoutingUnitTest.cpp)
engine_regression(compact_graph StochasticCompactGraphUnitTest.cpp)
engine_regression(graphviz_renderer LegacyGraphvizRendererUnitTest.cpp)
engine_regression(june_random_clock JuneRandomClockGraphUnitTest.cpp)
engine_regression(accelerated_bistable AcceleratedBistableUnitTest.cpp "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/xor2.qca")
engine_regression(accelerated_coherence AcceleratedCoherenceUnitTest.cpp "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/xor2.qca")
engine_regression(ordered_interaction_graph OrderedInteractionGraphUnitTest.cpp "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/xor2.qca")
engine_regression(sequential_ir SequentialIrUnitTest.cpp)
engine_regression(sequential_global_phase SequentialGlobalPhaseSolverUnitTest.cpp)
engine_regression(regular_clock_search RegularClockSearchUnitTest.cpp)
target_link_libraries(regular_clock_search PRIVATE ifcn_regular_search)
add_test(NAME regular_clock_native
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_regular_clock_native.py")
set_tests_properties(regular_clock_native PROPERTIES
  TIMEOUT 45 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")
engine_regression(physical_state_macro PhysicalStateMacroUnitTest.cpp "${CMAKE_CURRENT_BINARY_DIR}/physical_reset_toggle_macro.tex")

foreach(test_script IN ITEMS test_ifcn_agent.py test_ifcn_clock_arrival.py test_ifcn_agent_layout_validation.py test_yosys_json_to_seqir.py)
  get_filename_component(test_name "${test_script}" NAME_WE)
  add_test(NAME ${test_name} COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/${test_script}")
  set_tests_properties(${test_name} PROPERTIES TIMEOUT 45)
endforeach()
add_test(NAME physical_benchmark_smoke COMMAND ifcn_physical_benchmark
  "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/xor2.qca" --model both --repetitions 1
  --samples 128 --duration 2e-14 --time-step 1e-16
  --require-equivalent --equivalence-tolerance 0)
set_tests_properties(physical_benchmark_smoke PROPERTIES TIMEOUT 45)

if(IFCN_BUILD_PYTHON_BINDINGS)
  add_test(NAME fixed_clock_numpy_regression
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_fixed_clock_layout.py")
  set_tests_properties(fixed_clock_numpy_regression PROPERTIES
    TIMEOUT 50 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")
endif()

# Closed-loop native export, clock constraints, and rejection of forged phases.
add_test(NAME sequential_native_feedback
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_sequential_native.py"
          $<TARGET_FILE:ifcn_sequential_cyclic_pnr>)
set_tests_properties(sequential_native_feedback PROPERTIES TIMEOUT 70)

# Compare independent SeqIR and cut-DAG one-step state evaluation.
add_test(NAME sequential_next_state_validation
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_ifcn_sequential_validation.py")
set_tests_properties(sequential_next_state_validation PROPERTIES
  TIMEOUT 45 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")

if(IFCN_BUILD_PYTHON_BINDINGS)
  add_test(NAME sequential_flow_integration
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_ifcn_sequential_flow.py")
  set_tests_properties(sequential_flow_integration PROPERTIES
    TIMEOUT 240 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")
endif()

# Compare two June topologies under identical route/phase constraints and audit
# both routed Boolean functions and actually exported QCA device/terminal counts.
add_test(NAME native_combinational_optimization
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_native_combinational_optimization.py")
set_tests_properties(native_combinational_optimization PROPERTIES
  TIMEOUT 45 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")

# Enforce cycle-zero reconvergence while preserving free-clock route constraints.
add_test(NAME combinational_clock_rephase
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_combinational_rephase.py")
set_tests_properties(combinational_clock_rephase PROPERTIES
  TIMEOUT 45 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")

# Certify final emitted QCA route continuity and source isolation before selection.
add_test(NAME physical_export_validation
  COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/test_physical_export_validation.py")
set_tests_properties(physical_export_validation PROPERTIES
  TIMEOUT 45 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")

# Exact placement edits and auditable model/control optimization lifecycle.
foreach(test_script IN ITEMS test_layout_edit_native.py test_layout_optimization.py)
  get_filename_component(test_name "${test_script}" NAME_WE)
  add_test(NAME ${test_name} COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/${test_script}")
  set_tests_properties(${test_name} PROPERTIES TIMEOUT 60 ENVIRONMENT "IFCN_BUILD_DIR=${CMAKE_BINARY_DIR}")
endforeach()
